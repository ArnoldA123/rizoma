// Browser API client for the personnel listing (`GET /v1/users`).
//
// Same three rules as `lib/salud-api.ts`, for the same reasons:
//
//   1. the response is parsed with the `@rizoma/contracts` schema of its
//      endpoint, so a drift fails at the edge with `api.contract_mismatch`;
//   2. reads never carry an `Idempotency-Key` — this module only lists, so
//      there is no mutation and no replay key at all;
//   3. there is no request body to pre-flight; the query carries only the
//      filters the service parser accepts (`?orgNodeId=`, `?role=`,
//      `?active=`), and an unset filter is omitted rather than sent blank.
//
// The screen renders `name` (with `email` as a secondary hint) and keeps `id`
// as the option value: the identifier never reaches the visible label. The
// shape carries no `phone` or `mfa_enrolled` — no listing may select them.
import {
  userListSchema,
  type UserListQuery,
  type UserRecord,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { requestJson } from './api-client.ts';

/** Base path, mirroring `@Controller('users')`. */
const BASE = '/users';

/**
 * Reads a list endpoint. The API answers a bare array capped at 200 rows; an
 * empty body is normalized to `[]` so a screen distinguishes "no rows" from
 * "could not read".
 */
async function readList<T>(
  path: string,
  schema: ZodType<T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  const rows = await requestJson(path, schema, signal === undefined ? {} : { signal });
  return rows ?? [];
}

/** Filters of `GET /v1/users` — the query fields the screen may set. */
export interface ListUsersQuery extends UserListQuery {}

/**
 * `GET /v1/users` — personnel inside the caller subtree, newest first. Every
 * filter is optional; an unset filter is omitted from the query.
 */
export function listUsers(
  query: ListUsersQuery = {},
  signal?: AbortSignal,
): Promise<UserRecord[]> {
  const params = new URLSearchParams();
  if (query.orgNodeId !== undefined && query.orgNodeId !== null && query.orgNodeId !== '') {
    params.set('orgNodeId', query.orgNodeId);
  }
  if (query.role !== undefined && query.role !== null && query.role !== '') {
    params.set('role', query.role);
  }
  if (query.active !== undefined && query.active !== null) {
    params.set('active', query.active ? 'true' : 'false');
  }
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  return readList(`${BASE}${suffix}`, userListSchema, signal);
}
