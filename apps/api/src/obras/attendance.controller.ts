// Attendance endpoint — thin HTTP skin over `obras.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). The own-mark rule, the active
// assignment key and the approval authority all live in the service.
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  approveAttendance,
  dayAttendance,
  markAttendance,
  type AttendanceRecord,
} from './obras.service.ts';

@Controller('obras/attendance')
export class AttendanceController {
  /** `POST /v1/obras/attendance` — mark the caller's own attendance. */
  @Post()
  mark(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<AttendanceRecord> {
    return markAttendance(actorFromRequest(req), body);
  }

  /** `POST /v1/obras/attendance/:id/approve` — approve one mark (`attendance.approve`). */
  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
  ): Promise<AttendanceRecord> {
    return approveAttendance(actorFromRequest(req), id);
  }

  /** `GET /v1/obras/attendance?site=&date=` — marks of one day at one site. */
  @Get()
  day(
    @Req() req: TenantScopedRequest,
    @Query('site') site: string | undefined,
    @Query('date') date: string | undefined,
  ): Promise<AttendanceRecord[]> {
    return dayAttendance(actorFromRequest(req), site ?? '', date ?? '');
  }
}
