// Policy preview endpoint — thin HTTP skin over `policy.service.ts` (B5).
// No domain logic and no permission checks live here: the service owns the
// query validation, the matrix read and the catalog read, so the handler only
// forwards the request-bound tenant client. Read-only by construction: the
// only statement the service issues is a `SELECT`, and any membership of the
// tenant may preview (audit, not enforcement).
import { Controller, Get, HttpException, Query, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  getPolicyPreview,
  parsePreviewQuery,
  type PolicyPreview,
} from './policy.service.ts';

function readTraceId(req: TenantScopedRequest): string {
  const headers = req.headers ?? {};
  const header = headers['x-trace-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : randomUUID();
}

@Controller('policy')
export class PolicyController {
  /**
   * `GET /v1/policy/preview?role=&entity=&estado=` — which actions the role
   * holds and which catalog moves out of `estado` it may take, per the matrix
   * and the tenant catalog. Unknown roles answer 200 with everything denied
   * (deny-by-default, previewed); unknown entities answer 400.
   */
  @Get('preview')
  preview(
    @Req() req: TenantScopedRequest,
    @Query('role') role?: string,
    @Query('entity') entity?: string,
    @Query('estado') estado?: string,
  ): Promise<PolicyPreview> {
    const traceId = readTraceId(req);
    const tenant = req.tenant;
    const client = req.tenantClient;
    if (tenant === undefined || client === undefined) {
      throw new HttpException(
        { code: 'tenant.missing', message: 'Request has no tenant context', traceId },
        403,
      );
    }
    const query = parsePreviewQuery({ role, entity, estado }, traceId);
    return getPolicyPreview(client, tenant.tenantId, query.role, query.entity, query.estado);
  }
}
