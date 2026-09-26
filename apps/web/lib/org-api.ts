// Browser API client for the org tree (`GET /v1/org/nodes`).
//
// Same three rules as `lib/salud-api.ts`, for the same reasons:
//
//   1. the response is parsed with the `@rizoma/contracts` schema of its
//      endpoint, so a drift fails at the edge with `api.contract_mismatch`;
//   2. reads never carry an `Idempotency-Key` — this module only lists, so
//      there is no mutation and no replay key at all;
//   3. there is no request body to pre-flight; the query carries only the
//      filters the service parser accepts (`?kind=`, `?active=`, `?parent=`),
//      and an unset filter is omitted rather than sent blank.
//
// The screen renders `name` and keeps `id` as the option value: the identifier
// never reaches the visible label.
import {
  orgNodeListSchema,
  type OrgNodeListQuery,
  type OrgNodeRecord,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { requestJson } from './api-client.ts';

/** Base path, mirroring `@Controller('org/nodes')`. */
const BASE = '/org/nodes';

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

/** Filters of `GET /v1/org/nodes` — the query fields the screen may set. */
export interface ListOrgNodesQuery extends OrgNodeListQuery {}

/**
 * `GET /v1/org/nodes` — org nodes inside the caller subtree, alphabetical by
 * name. Every filter is optional; an unset filter is omitted from the query.
 */
export function listOrgNodes(
  query: ListOrgNodesQuery = {},
  signal?: AbortSignal,
): Promise<OrgNodeRecord[]> {
  const params = new URLSearchParams();
  if (query.kind !== undefined && query.kind !== null && query.kind !== '') {
    params.set('kind', query.kind);
  }
  if (query.active !== undefined && query.active !== null) {
    params.set('active', query.active ? 'true' : 'false');
  }
  if (query.parent !== undefined && query.parent !== null && query.parent !== '') {
    params.set('parent', query.parent);
  }
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  return readList(`${BASE}${suffix}`, orgNodeListSchema, signal);
}
