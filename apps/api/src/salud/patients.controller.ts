// Patients endpoint — thin HTTP skin over `salud.service.ts`
// (bases-consolidadas-v1.md §3.3, §6.1). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns the guard, the SQL and the write audit.
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  createPatient,
  getPatient,
  listPatients,
  updatePatient,
  type PatientRecord,
} from './salud.service.ts';

@Controller('salud/patients')
export class PatientsController {
  /** `GET /v1/salud/patients` — patient files inside the caller scope. */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('saved_view_id') savedViewId?: string,
  ): Promise<PatientRecord[]> {
    return listPatients(actorFromRequest(req), savedViewId ?? null);
  }

  /** `POST /v1/salud/patients` — register a patient file (`patient.write`). */
  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<PatientRecord> {
    return createPatient(actorFromRequest(req), body);
  }

  /** `GET /v1/salud/patients/:id` — open one patient file (`patient.read`). */
  @Get(':id')
  get(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<PatientRecord> {
    return getPatient(actorFromRequest(req), id);
  }

  /** `PATCH /v1/salud/patients/:id` — edit a patient file (`patient.write`). */
  @Patch(':id')
  update(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PatientRecord> {
    return updatePatient(actorFromRequest(req), id, body);
  }
}
