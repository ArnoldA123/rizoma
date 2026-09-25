// Site log endpoint — thin HTTP skin over `resources.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). The draft→published transition, the
// on-site guard and the write audit stay in the service.
import { Body, Controller, HttpCode, Param, Post, Get, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  createSiteLog,
  listSiteLogs,
  publishSiteLog,
  type SiteLogRecord,
} from './resources.service.ts';

@Controller('obras/sites/:siteId/logs')
export class SiteLogsController {
  /** `GET /v1/obras/sites/:siteId/logs` — site logs (`site.read`). */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
  ): Promise<SiteLogRecord[]> {
    return listSiteLogs(actorFromRequest(req), siteId);
  }

  /** `POST /v1/obras/sites/:siteId/logs` — append a draft log (on-site write). */
  @Post()
  create(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Body() body: unknown,
  ): Promise<SiteLogRecord> {
    return createSiteLog(actorFromRequest(req), siteId, body);
  }

  /** `POST /v1/obras/sites/:siteId/logs/:id/publish` — publish a draft. */
  @Post(':id/publish')
  @HttpCode(200)
  publish(
    @Req() req: TenantScopedRequest,
    @Param('siteId') siteId: string,
    @Param('id') id: string,
  ): Promise<SiteLogRecord> {
    return publishSiteLog(actorFromRequest(req), siteId, id);
  }
}
