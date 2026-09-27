// Prescriptions endpoint — thin HTTP skin over `prescriptions.service.ts`
// (bases-consolidadas-v1.md §2.3). The service owns validation, the guard, the
// sede scope and the write audit; the controller only maps request data to the
// use case.
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './salud.service.ts';
import {
  createPrescription,
  listPrescriptions,
  transitionPrescription,
  type PrescriptionRecord,
} from './prescriptions.service.ts';

@Controller('salud/prescriptions')
export class PrescriptionsController {
  /**
   * `GET /v1/salud/prescriptions` — order history filtered by `?patient=` or
   * `?episode=` (at least one is required).
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('patient') patient: string | undefined,
    @Query('episode') episode: string | undefined,
  ): Promise<PrescriptionRecord[]> {
    return listPrescriptions(actorFromRequest(req), { patientId: patient, episodeId: episode });
  }

  /** `POST /v1/salud/prescriptions` — create one order (`episode.write`). */
  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<PrescriptionRecord> {
    return createPrescription(actorFromRequest(req), body);
  }

  /**
   * `PATCH /v1/salud/prescriptions/:id` — Emitir (`issued`) or Anular
   * (`cancelled`) a `draft` order of an `open` episode (`episode.write`,
   * `medico`). One `audit_log` row per accepted move.
   */
  @Patch(':id')
  transition(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PrescriptionRecord> {
    const status = (body as { status?: unknown } | null | undefined)?.status;
    return transitionPrescription(actorFromRequest(req), id, status);
  }
}
