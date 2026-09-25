// Obras dashboards endpoint — thin HTTP skin over `dashboards.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4, §6.2). No domain logic and no
// permission checks live here: the service owns the guard, the scope and the
// KPI queries, so the handler only forwards the request facts.
import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import { getCompanyBoard, getSiteBoard, type CompanyBoard, type SiteBoard } from './dashboards.service.ts';

@Controller('obras')
export class ObrasDashboardsController {
  /** `GET /v1/obras/sites/:siteId/board?date=` — the board of one site. */
  @Get('sites/:siteId/board')
  siteBoard(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Query('date') date?: string,
  ): Promise<SiteBoard> {
    return getSiteBoard(actorFromRequest(req), siteId, date);
  }

  /** `GET /v1/obras/board` — the company board over the caller scope. */
  @Get('board')
  companyBoard(@Req() req: TenantScopedRequest): Promise<CompanyBoard> {
    return getCompanyBoard(actorFromRequest(req));
  }
}
