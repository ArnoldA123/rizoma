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
  listPatientsPage,
  updatePatient,
  type PatientRecord,
  type SaludPage,
} from './salud.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type PatientPage = SaludPage<PatientRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('salud/patients')
export class PatientsController {
  /**
   * `GET /v1/salud/patients` — patient files inside the caller scope.
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `created_at DESC, id DESC`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('saved_view_id') savedViewId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PatientRecord[] | PatientPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listPatients(actorFromRequest(req), savedViewId ?? null);
    }
    return listPatientsPage(actorFromRequest(req), {
      savedViewId: savedViewId ?? null,
      cursor: pageCursor,
      limit: pageLimit,
    });
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
