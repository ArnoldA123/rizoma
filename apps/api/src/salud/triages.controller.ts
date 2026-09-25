// Triages endpoint — thin HTTP skin over `triages.service.ts`
// (bases-consolidadas-v1.md §2.3). Insert-only by design: the service owns
// validation, the guard, the sede scope and the write audit; the controller
// only maps request data to the use case.
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './salud.service.ts';
import { createTriage, listTriages, type TriageRecord } from './triages.service.ts';

@Controller('salud/triages')
export class TriagesController {
  /** `GET /v1/salud/triages?patient=` — vital-signs history of one patient. */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('patient') patient: string | undefined,
  ): Promise<TriageRecord[]> {
    return listTriages(actorFromRequest(req), patient ?? '');
  }

  /** `POST /v1/salud/triages` — record one vital-signs row (`patient.write`). */
  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<TriageRecord> {
    return createTriage(actorFromRequest(req), body);
  }
}
