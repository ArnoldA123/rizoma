// Crews endpoint — thin HTTP skin over `crews.service.ts` (P2-4a).
// No domain logic and no permission checks live here: every handler forwards
// the request-bound tenant client to the service, which owns the guard, the
// scope, the filters and the SQL.
import { Controller, Get, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import { actorFromRequest } from './obras.service.ts';
import {
  listCrews,
  listCrewsPage,
  type CrewPage,
  type CrewRecord,
} from './crews.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type CrewsPage = CrewPage<CrewRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('obras/crews')
export class CrewsController {
  /**
   * `GET /v1/obras/crews` — crews inside the caller scope (`site.read`).
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `name ASC, id ASC`. Filters: `?orgNodeId=`, `?active=`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('orgNodeId') orgNodeId?: string,
    @Query('active') active?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<CrewRecord[] | CrewsPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    if (pageCursor === null && pageLimit === null) {
      return listCrews(actorFromRequest(req), { orgNodeId, active });
    }
    return listCrewsPage(actorFromRequest(req), {
      orgNodeId,
      active,
      cursor: pageCursor,
      limit: pageLimit,
    });
  }
}
