// Obras dashboards endpoint — thin HTTP skin over `dashboards.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4, §6.2). No domain logic and no
// permission checks live here: the service owns the guard, the scope and the
// KPI queries, so the handler only forwards the request facts.
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import type { BoardCacheClient } from '../cache/boards.ts';
import { REDIS_CLIENT } from '../health/health.controller.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  exportCompanyBoard,
  exportSiteBoard,
  getComparedCompanyBoard,
  getComparedSiteBoard,
  getCompanyBoard,
  getSiteBoard,
  type BoardExport,
  type ComparedCompanyBoard,
  type ComparedSiteBoard,
  type CompanyBoard,
  type SiteBoard,
} from './dashboards.service.ts';

@Controller('obras')
export class ObrasDashboardsController {
  constructor(@Inject(REDIS_CLIENT) private readonly cache: BoardCacheClient) {}
  /**
   * `GET /v1/obras/sites/:siteId/board/export?date=&format=csv` — BI export of
   * the site board. Same aggregates and same `LIMIT` as the JSON board,
   * progress-line grain with the day attendance as context columns.
   */
  @Get('sites/:siteId/board/export')
  async siteExport(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Query('date') date?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<string> {
    const exported: BoardExport = await exportSiteBoard(actorFromRequest(req), siteId, date, format);
    res?.set('Content-Type', exported.contentType);
    res?.set('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return exported.csv;
  }

  /**
   * `GET /v1/obras/sites/:siteId/board?date=&compare=` — the board of one site.
   * With `?compare=previous-week` the answer is `{current, previous, delta}`:
   * the board of the day next to the board of −7d, same SQL on both legs.
   */
  @Get('sites/:siteId/board')
  siteBoard(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Query('date') date?: string,
    @Query('compare') compare?: string,
  ): Promise<SiteBoard | ComparedSiteBoard> {
    if (compare !== undefined && compare.trim() !== '') {
      return getComparedSiteBoard(actorFromRequest(req), siteId, date, compare, this.cache);
    }
    return getSiteBoard(actorFromRequest(req), siteId, date, this.cache);
  }

  /**
   * `GET /v1/obras/board/export?date=&format=csv` — BI export of the company
   * board. Same aggregate as the JSON board, one CSV row.
   */
  @Get('board/export')
  async companyExport(
    @Req() req: TenantScopedRequest,
    @Query('date') date?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<string> {
    const exported: BoardExport = await exportCompanyBoard(actorFromRequest(req), date, format);
    res?.set('Content-Type', exported.contentType);
    res?.set('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return exported.csv;
  }

  /**
   * `GET /v1/obras/board?date=&compare=` — the company board over the caller
   * scope. With `?compare=previous-week` the answer is `{current, previous,
   * delta}` (scope-state snapshots; see the service for the semantics).
   */
  @Get('board')
  companyBoard(
    @Req() req: TenantScopedRequest,
    @Query('date') date?: string,
    @Query('compare') compare?: string,
  ): Promise<CompanyBoard | ComparedCompanyBoard> {
    if (compare !== undefined && compare.trim() !== '') {
      return getComparedCompanyBoard(actorFromRequest(req), date, compare, this.cache);
    }
    return getCompanyBoard(actorFromRequest(req), date, this.cache);
  }
}
