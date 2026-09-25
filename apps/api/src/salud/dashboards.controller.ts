// Role dashboards endpoint — thin HTTP skin over `dashboards.service.ts`
// (bases-consolidadas-v1.md §6.3). No domain logic and no permission checks
// live here: the service owns the board-role validation, the guard and the KPI
// queries, so the handler only forwards the request facts.
import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './salud.service.ts';
import { getBoard, type DashboardBoard } from './dashboards.service.ts';

@Controller('salud/dashboards')
export class DashboardsController {
  /** `GET /v1/salud/dashboards/:role?org=&date=` — one board per role. */
  @Get(':role')
  board(
    @Req() req: TenantScopedRequest,
    @Param('role') role: string,
    @Query('org') org?: string,
    @Query('date') date?: string,
  ): Promise<DashboardBoard> {
    return getBoard(actorFromRequest(req), role, org, date);
  }
}
