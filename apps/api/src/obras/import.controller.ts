// Obras CSV imports endpoint — thin HTTP skin over `import.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns validation, the guard, the per-row import and the
// write audit. The `Idempotency-Key` header is the only extra request fact the
// create routes need, so it is read here and passed through unchanged.
import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  getImportJob,
  importAssets,
  importWorkers,
  IMPORT_IDEMPOTENCY_KEY_HEADER,
  type ImportJobRecord,
} from './import.service.ts';

@Controller('obras/imports')
export class ObrasImportsController {
  /** `POST /v1/obras/imports/workers` — imports a workers CSV (idempotent). */
  @Post('workers')
  workers(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
    @Headers(IMPORT_IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<ImportJobRecord> {
    return importWorkers(actorFromRequest(req), body, idempotencyKey);
  }

  /** `POST /v1/obras/imports/assets` — imports an equipment CSV (idempotent). */
  @Post('assets')
  assets(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
    @Headers(IMPORT_IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<ImportJobRecord> {
    return importAssets(actorFromRequest(req), body, idempotencyKey);
  }

  /** `GET /v1/obras/imports/:id` — import job detail, errors CSV included. */
  @Get(':id')
  job(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<ImportJobRecord> {
    return getImportJob(actorFromRequest(req), id);
  }
}
