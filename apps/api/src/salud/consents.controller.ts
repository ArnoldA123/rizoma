// Consents endpoint — thin HTTP skin over `consents.service.ts`
// (peru-anexo-v1.md §2). No domain logic and no permission checks live here:
// every handler forwards the request-bound tenant client to the service, which
// owns validation, the guard, the versioned decision matrix and the write
// audit.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './salud.service.ts';
import {
  createPending,
  listConsents,
  revokeConsent,
  signConsent,
  type ConsentRecord,
} from './consents.service.ts';

@Controller('salud/consents')
export class ConsentsController {
  /** `GET /v1/salud/consents?patient=` — consent history of one patient. */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('patient') patient: string | undefined,
  ): Promise<ConsentRecord[]> {
    return listConsents(actorFromRequest(req), patient ?? '');
  }

  /** `POST /v1/salud/consents` — create the `pending` consent row. */
  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<ConsentRecord> {
    return createPending(actorFromRequest(req), body);
  }

  /** `POST /v1/salud/consents/:id/sign` — attach evidence and sign. */
  @Post(':id/sign')
  @HttpCode(200)
  sign(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ConsentRecord> {
    return signConsent(actorFromRequest(req), id, body);
  }

  /** `POST /v1/salud/consents/:id/revoke` — `signed → revoked`. */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<ConsentRecord> {
    return revokeConsent(actorFromRequest(req), id);
  }
}
