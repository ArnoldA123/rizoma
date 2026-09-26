// Users endpoint — thin HTTP skin over `users.service.ts`
// (odd/tasks/ux-p2-nombres-uuid.md P2-0c). No domain logic and no permission
// checks live here: every handler forwards the request-bound tenant client to
// the service, which owns the guard, the subtree scope, the SQL and the audit.
// The listing never exposes `phone` or `mfa_enrolled` (see the service).
import { Controller, Get, Query, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  listUsers,
  listUsersPage,
  type UserPage,
  type UserRecord,
} from './users.service.ts';

/** Paged envelope returned only when the caller sends `?cursor=` or `?limit=`. */
export type UsersPage = UserPage<UserRecord>;

/** Non-empty query param, or null when absent/blank (legacy bare-array path). */
function readPageParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

@Controller('users')
export class UsersController {
  /**
   * `GET /v1/users` — personnel inside the caller subtree.
   * Without `?cursor=`/`?limit=` answers the legacy bare array (cap 200);
   * with either, answers the keyset page `{rows, nextCursor}` ordered by
   * `created_at DESC, id DESC`. Filters: `?orgNodeId=`, `?role=`, `?active=`.
   */
  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Query('orgNodeId') orgNodeId?: string,
    @Query('role') role?: string,
    @Query('active') active?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<UserRecord[] | UsersPage> {
    const pageCursor = readPageParam(cursor);
    const pageLimit = readPageParam(limit);
    const query = { orgNodeId, role, active, cursor: pageCursor, limit: pageLimit };
    if (pageCursor === null && pageLimit === null) {
      return listUsers(actorFromRequest(req), query);
    }
    return listUsersPage(actorFromRequest(req), query);
  }
}
