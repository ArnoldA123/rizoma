// Sites endpoint — thin HTTP skin over `obras.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns the guard, the assignment key, the SQL and the audit.
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  createSite,
  getSite,
  listSites,
  type SiteRecord,
} from './obras.service.ts';

@Controller('obras/sites')
export class SitesController {
  /** `GET /v1/obras/sites` — sites inside the caller scope. */
  @Get()
  list(@Req() req: TenantScopedRequest): Promise<SiteRecord[]> {
    return listSites(actorFromRequest(req));
  }

  /** `POST /v1/obras/sites` — create a site (`site.write`, gerente). */
  @Post()
  create(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<SiteRecord> {
    return createSite(actorFromRequest(req), body);
  }

  /** `GET /v1/obras/sites/:id` — open one site (`site.read`). */
  @Get(':id')
  get(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<SiteRecord> {
    return getSite(actorFromRequest(req), id);
  }
}
