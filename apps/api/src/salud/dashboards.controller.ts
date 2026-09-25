// Role dashboards endpoint — thin HTTP skin over `dashboards.service.ts`
// (bases-consolidadas-v1.md §6.3). No domain logic and no permission checks
// live here: the service owns the board-role validation, the guard and the KPI
// queries, so the handler only forwards the request facts.
import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './salud.service.ts';
import {
  exportBoard,
  getBoard,
  getComparedBoard,
  type BoardExport,
  type ComparedDashboardBoard,
  type DashboardBoard,
} from './dashboards.service.ts';

@Controller('salud/dashboards')
export class DashboardsController {
  /**
   * `GET /v1/salud/dashboards/:role/export?org=&date=&format=csv` — BI export
   * of the board aggregate. Same numbers as the JSON board, one CSV row. The
   * filename comes from the service and only carries validated characters; it
   * is sent as an attachment like the imports errors CSV.
   */
  @Get(':role/export')
  async export(
    @Req() req: TenantScopedRequest,
    @Param('role') role: string,
    @Query('org') org?: string,
    @Query('date') date?: string,
    @Query('format') format?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<string> {
    const exported: BoardExport = await exportBoard(actorFromRequest(req), role, org, date, format);
    res?.set('Content-Type', exported.contentType);
    res?.set('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return exported.csv;
  }

  /**
   * `GET /v1/salud/dashboards/:role?org=&date=&compare=` — one board per role.
   * With `?compare=previous-week` the answer is `{current, previous, delta}`:
   * the board of the day next to the board of −7d, same SQL on both legs.
   */
  @Get(':role')
  board(
    @Req() req: TenantScopedRequest,
    @Param('role') role: string,
    @Query('org') org?: string,
    @Query('date') date?: string,
    @Query('compare') compare?: string,
  ): Promise<DashboardBoard | ComparedDashboardBoard> {
    if (compare !== undefined && compare.trim() !== '') {
      return getComparedBoard(actorFromRequest(req), role, org, date, compare);
    }
    return getBoard(actorFromRequest(req), role, org, date);
  }
}
