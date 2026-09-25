// Patients importer endpoint — thin HTTP skin over `import.service.ts`
// (bases-consolidadas-v1.md §5.1, §5.4). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns validation, the guard, the per-row import and the
// write audit. The `Idempotency-Key` header is the only extra request fact the
// create route needs, so it is read here and passed through unchanged.
import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './salud.service.ts';
import {
  getImportJob,
  importPatients,
  IMPORT_IDEMPOTENCY_KEY_HEADER,
  type ImportJobRecord,
} from './import.service.ts';

@Controller('salud/imports')
export class ImportsController {
  /** `POST /v1/salud/imports/patients` — imports a patients CSV (idempotent). */
  @Post('patients')
  create(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
    @Headers(IMPORT_IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<ImportJobRecord> {
    return importPatients(actorFromRequest(req), body, idempotencyKey);
  }

  /** `GET /v1/salud/imports/:id` — import job detail, errors CSV included. */
  @Get(':id')
  job(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<ImportJobRecord> {
    return getImportJob(actorFromRequest(req), id);
  }
}
