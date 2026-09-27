// Appointments endpoint — thin HTTP skin over `salud.service.ts`
// (bases-consolidadas-v1.md §2.3, §3.3). Guard, scope, state and audit stay in
// the service.
import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  createAppointment,
  deriveAppointment,
  getAppointment,
  listAppointments,
  listAppointmentsPage,
  rescheduleAppointment,
  updateAppointmentStatus,
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
   * `?status=` keeps one status, `?exclude_status=` drops one (both 400 on
   * an unknown status). The reception queue (P4-2b) lists with
   * `?exclude_status=derived`: a derived visit left the agenda, so the desk
   * no longer offers it for Confirmar/Atender/No-show/Reprogramar/Anular.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('saved_view_id') savedViewId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('exclude_status') excludeStatus?: string,
  ): Promise<AppointmentRecord[] | AppointmentPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    const filter = {
      status: readPageParam(status),
      excludeStatus: readPageParam(excludeStatus),
    };
    if (pageCursor === null && pageLimit === null) {
      return listAppointments(actorFromRequest(req), savedViewId ?? null, filter);
    }
    return listAppointmentsPage(actorFromRequest(req), {
      savedViewId: savedViewId ?? null,
      cursor: pageCursor,
      limit: pageLimit,
      ...filter,
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

  /**
   * `PATCH /v1/salud/appointments/:id/status` — one move of the closed
   * machine (`{status}`). The desk (`appointment.write`) or the owning
   * medico (`appointment.attend` over its own agenda) moves; `caja` is
   * denied as today. Unknown statuses are 400, refused moves are 403.
   */
  @Patch(':id/status')
  updateStatus(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AppointmentRecord> {
    const status = (body as { status?: unknown } | null | undefined)?.status;
    return updateAppointmentStatus(actorFromRequest(req), id, status);
  }

  /**
   * `PATCH /v1/salud/appointments/:id/reschedule` — moves `startsAt` (and
   * optionally `durationMin`) from `scheduled`/`confirmed`, keeping the
   * status. Cancels the deferred notice when one exists (P4-3 hook); the
   * fresh notice for the new slot is P4-3's.
   */
  @Patch(':id/reschedule')
  reschedule(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AppointmentRecord> {
    return rescheduleAppointment(actorFromRequest(req), id, body);
  }

  /**
   * `POST /v1/salud/appointments/:id/derive` — hands a `scheduled` visit to
   * another service (`derived` + audit). The reception queue filters it out
   * from here on (see the `exclude_status` listing filter).
   */
  @Post(':id/derive')
  derive(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
  ): Promise<AppointmentRecord> {
    return deriveAppointment(actorFromRequest(req), id);
  }
}
