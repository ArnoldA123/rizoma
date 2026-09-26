// Org endpoint — thin HTTP skin over `org.service.ts`
// (odd/tasks/ux-p2-nombres-uuid.md P2-0c). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns the guard, the subtree scope, the SQL and the audit.
import { Controller, Get, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  listOrgNodes,
  listOrgNodesPage,
  type OrgNodeRecord,
  type OrgPage,
} from './org.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type OrgNodePage = OrgPage<OrgNodeRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('org/nodes')
export class OrgController {
  /**
   * `GET /v1/org/nodes` — org nodes inside the caller subtree.
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `name ASC, id ASC`. Filters: `?kind=`, `?active=`, `?parent=`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('kind') kind?: string,
    @Query('active') active?: string,
    @Query('parent') parent?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<OrgNodeRecord[] | OrgNodePage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    const query = { kind, active, parent, cursor: pageCursor, limit: pageLimit };
    if (pageCursor === null && pageLimit === null) {
      return listOrgNodes(actorFromRequest(req), query);
    }
    return listOrgNodesPage(actorFromRequest(req), query);
  }
}
