// Appointments endpoint — thin HTTP skin over `salud.service.ts`
// (bases-consolidadas-v1.md §2.3, §3.3). Guard, scope, state and audit stay in
// the service.
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  createAppointment,
  getAppointment,
  listAppointments,
  type AppointmentRecord,
} from './salud.service.ts';

@Controller('salud/appointments')
export class AppointmentsController {
  /** `GET /v1/salud/appointments` — agenda inside the caller scope. */
  @Get()
  list(@Req() req: TenantScopedRequest): Promise<AppointmentRecord[]> {
    return listAppointments(actorFromRequest(req));
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
