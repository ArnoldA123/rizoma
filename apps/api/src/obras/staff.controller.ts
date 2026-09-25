// Site staff endpoint — thin HTTP skin over `obras.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). Assignment authority (`gerente` or
// `jefe_obra` in its own site) and the active-assignment key stay in the
// service.
import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  assignWorker,
  closeAssignment,
  listSiteStaff,
  type AssignmentRecord,
  type SiteStaffRecord,
} from './obras.service.ts';

@Controller('obras/sites/:siteId/staff')
export class StaffController {
  /** `GET /v1/obras/sites/:siteId/staff` — active assignments of the site. */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
  ): Promise<SiteStaffRecord[]> {
    return listSiteStaff(actorFromRequest(req), siteId);
  }

  /** `POST /v1/obras/sites/:siteId/staff` — assign a worker (`assignment.write`). */
  @Post()
  assign(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Body() body: unknown,
  ): Promise<AssignmentRecord> {
    return assignWorker(actorFromRequest(req), siteId, body);
  }

  /** `POST /v1/obras/sites/:siteId/staff/:userId/close` — end the assignment. */
  @Post(':userId/close')
  @HttpCode(200)
  close(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Param('userId') userId: string,
  ): Promise<AssignmentRecord> {
    return closeAssignment(actorFromRequest(req), siteId, userId);
  }
}
