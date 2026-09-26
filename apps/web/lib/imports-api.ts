// Browser API client for the import-job listing (`GET /v1/imports/jobs`).
//
// Same three rules as `lib/salud-api.ts`, for the same reasons:
//
//   1. the response is parsed with the `@rizoma/contracts` schema of its
//      endpoint, so a drift fails at the edge with `api.contract_mismatch`;
//   2. reads never carry an `Idempotency-Key` — this module only lists, so
//      there is no mutation and no replay key at all;
//   3. there is no request body to pre-flight; the query carries only the
//      filters the service parser accepts (`?kind=`, `?status=`), and an unset
//      filter is omitted rather than sent blank.
//
// The listing exposes identity, kind, outcome and counters only — the source
// digests and the errors CSV stay on the detail route (`GET .../imports/:id`
// of each vertical), so a wide scan never drags the file payloads along. The
// screens render `kind` plus status, date and counters, and keep `id` as the
// option value: the identifier never reaches the visible label.
import {
  importJobListSchema,
  type ImportJobListItem,
  type ImportJobListQuery,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { requestJson } from './api-client.ts';

/** Base path, mirroring `@Controller('imports')`. */
const BASE = '/imports';

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

/** Filters of `GET /v1/imports/jobs` — the query fields the screen may set. */
export interface ListImportJobsQuery extends ImportJobListQuery {}

/**
 * `GET /v1/imports/jobs` — import jobs of the tenant, newest first, capped at
 * 200 rows. Every filter is optional; an unset filter is omitted from the
 * query.
 */
export function listImportJobs(
  query: ListImportJobsQuery = {},
  signal?: AbortSignal,
): Promise<ImportJobListItem[]> {
  const params = new URLSearchParams();
  if (query.kind !== undefined && query.kind !== null && query.kind !== '') {
    params.set('kind', query.kind);
  }
  if (query.status !== undefined && query.status !== null && query.status !== '') {
    params.set('status', query.status);
  }
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  return readList(`${BASE}/jobs${suffix}`, importJobListSchema, signal);
}
