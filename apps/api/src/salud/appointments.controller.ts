// Appointments endpoint — thin HTTP skin over `salud.service.ts`
// (bases-consolidadas-v1.md §2.3, §3.3). Guard, scope, state and audit stay in
// the service.
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  createAppointment,
  getAppointment,
  listAppointments,
  listAppointmentsPage,
  type AppointmentRecord,
  type SaludPage,
} from './salud.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type AppointmentPage = SaludPage<AppointmentRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('salud/appointments')
export class AppointmentsController {
  /**
   * `GET /v1/salud/appointments` — agenda inside the caller scope.
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `starts_at DESC, id DESC`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('saved_view_id') savedViewId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<AppointmentRecord[] | AppointmentPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listAppointments(actorFromRequest(req), savedViewId ?? null);
    }
    return listAppointmentsPage(actorFromRequest(req), {
      savedViewId: savedViewId ?? null,
      cursor: pageCursor,
      limit: pageLimit,
    });
  }

  /** `POST /v1/salud/appointments` — schedule an appointment. */
  @Post()
  create(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
  ): Promise<AppointmentRecord> {
    return createAppointment(actorFromRequest(req), body);
  }

  /** `GET /v1/salud/appointments/:id` — read one appointment within scope. */
  @Get(':id')
  get(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<AppointmentRecord> {
    return getAppointment(actorFromRequest(req), id);
  }
}
