// Browser API client for saved views (`POST/GET/PATCH/DELETE /v1/views`).
//
// One module owns the path, the verb and the contract schema of every call a
// view selector or the view form makes, so a screen never assembles a URL or a
// body by hand. Same rules as `lib/salud-api.ts`, for the same reasons:
//
//   1. the response is parsed with the `@rizoma/contracts` schema of its
//      endpoint, so a drift fails at the edge with `api.contract_mismatch`;
//   2. the body is pre-flighted with the same schema the API service validates
//      against, so an invalid filter bag is refused in the browser;
//   3. errors are never swallowed: `ApiRequestError` carries `{code, reason,
//      traceId}` and the caller classifies it with `lib/salud-errors.ts`.
//
// Views hold no replay key: `POST /v1/views` creates a new row per call (the
// idempotency of a filter bag is meaningless), and PATCH/DELETE are
// idempotent by row state (`active`, ownership).
import {
  savedViewCreateInputSchema,
  savedViewListSchema,
  savedViewRecordSchema,
  savedViewUpdateInputSchema,
  savedViewsQueryString,
  savedViewIdQueryString,
  type SavedViewCreateInput,
  type SavedViewRecord,
  type SavedViewsQuery,
  type SavedViewUpdateInput,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { requestJson } from './api-client.ts';

/** Base path of the controller (`@Controller('views')` under `/v1`). */
const BASE = '/views';

/**
 * Reads a list endpoint. The API answers a bare array capped at 200 rows; an
 * empty body is normalized to `[]` so a screen can distinguish "no views" (a
 * typed empty state) from "could not read" (a failure panel).
 */
async function readList<T>(path: string, schema: ZodType<T[]>, signal?: AbortSignal): Promise<T[]> {
  const rows = await requestJson(path, schema, signal === undefined ? {} : { signal });
  return rows ?? [];
}

/** Reads one record; the API answers 404 with a typed envelope when absent. */
async function readOne<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
  const record = await requestJson(path, schema, signal === undefined ? {} : { signal });
  if (record === null) {
    throw new Error(`El API respondió sin cuerpo para ${path}`);
  }
  return record;
}

// ============ saved views ============

/** `GET /v1/views` — own views plus shared ones; `?entity=` narrows. */
export function listSavedViews(
  query: SavedViewsQuery = {},
  signal?: AbortSignal,
): Promise<SavedViewRecord[]> {
  return readList(`${BASE}${savedViewsQueryString(query)}`, savedViewListSchema, signal);
}

/** `GET /v1/views/:id` — one visible view. */
export function getSavedView(viewId: string, signal?: AbortSignal): Promise<SavedViewRecord> {
  return readOne(`${BASE}/${encodeURIComponent(viewId)}`, savedViewRecordSchema, signal);
}

/** `POST /v1/views` — stores one filter bag for one list entity. */
export async function createSavedView(input: SavedViewCreateInput): Promise<SavedViewRecord> {
  const body = savedViewCreateInputSchema.parse(input);
  const record = await requestJson(BASE, savedViewRecordSchema, { method: 'POST', body });
  if (record === null) throw new Error(`El API respondió sin cuerpo para ${BASE}`);
  return record;
}

/** `PATCH /v1/views/:id` — owner only. */
export async function updateSavedView(
  viewId: string,
  input: SavedViewUpdateInput,
): Promise<SavedViewRecord> {
  const body = savedViewUpdateInputSchema.parse(input);
  const record = await requestJson(`${BASE}/${encodeURIComponent(viewId)}`, savedViewRecordSchema, {
    method: 'PATCH',
    body,
  });
  if (record === null) throw new Error('La actualización de vista no devolvió cuerpo.');
  return record;
}

/** `DELETE /v1/views/:id` — owner only, soft delete (`active = FALSE`). */
export async function deleteSavedView(viewId: string): Promise<SavedViewRecord> {
  const record = await requestJson(`${BASE}/${encodeURIComponent(viewId)}`, savedViewRecordSchema, {
    method: 'DELETE',
  });
  if (record === null) throw new Error('La eliminación de vista no devolvió cuerpo.');
  return record;
}

// ============ listing integration ============

/**
 * Appends `?saved_view_id=` to an existing listing path. The server resolves
 * the view and applies its exact-equality filters; a missing view is 404 and
 * an entity mismatch is 400 — both loud by design, never silent. Screens keep
 * calling their own list readers; this helper only names the suffix once the
 * listing controllers accept the parameter.
 */
export function withSavedView(listPath: string, savedViewId: string | null | undefined): string {
  return `${listPath}${savedViewIdQueryString(savedViewId)}`;
}
