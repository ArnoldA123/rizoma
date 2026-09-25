// Sites endpoint — thin HTTP skin over `obras.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns the guard, the assignment key, the SQL and the audit.
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  createSite,
  getSite,
  listSites,
  listSitesPage,
  type ObraPage,
  type SiteRecord,
} from './obras.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type SitePage = ObraPage<SiteRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('obras/sites')
export class SitesController {
  /**
   * `GET /v1/obras/sites` — sites inside the caller scope.
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `code ASC, id ASC`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<SiteRecord[] | SitePage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listSites(actorFromRequest(req));
    }
    return listSitesPage(actorFromRequest(req), { cursor: pageCursor, limit: pageLimit });
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
