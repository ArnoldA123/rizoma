// Keyset (cursor) pagination contracts (R1).
//
// Ten-plus list endpoints used to truncate silently at `*_LIST_LIMIT = 200`
// with no cursor. This module is the shared contract for the opt-in keyset
// pages: an opaque `cursor` (base64url of the last ordering key) plus `limit`
// (default 200, max 200) and the `{rows, nextCursor}` envelope. When the
// caller sends no `?cursor=` and no `?limit=`, the API keeps returning the
// legacy bare array — the envelope only appears once pagination is requested,
// so existing readers never change shape under them.
//
// Stable order per endpoint (the cursor key is the last value of this order;
// `nextCursor` is null when the page is the last one):
//   patients:     (created_at DESC, id DESC)
//   appointments: (starts_at DESC, id DESC)
//   invoices:     (created_at DESC, id DESC)
//   sites:        (code ASC, id ASC)
//   assets:       (code ASC, id ASC)
//   stock moves:  (at DESC, id DESC)
//
// Like `common.ts`, this module uses only the stable Zod API surface so the
// schemas keep working across Zod 3.x and 4.x, and only `zod` is imported so
// re-exporting from `common.ts` creates no import cycle.
import { z } from 'zod';

/** Page size when the caller sends no `?limit=` (matches `*_LIST_LIMIT`). */
export const PAGINATION_DEFAULT_LIMIT = 200;

/** Hard cap: a larger `?limit=` is clamped, never applied. */
export const PAGINATION_MAX_LIMIT = 200;

/** Smallest accepted `?limit=`; anything smaller is a 400. */
export const PAGINATION_MIN_LIMIT = 1;

/**
 * Query params shared by every keyset listing. Empty strings count as absent
 * (Nest delivers `?limit=` as `''`): callers normalize them to `undefined`
 * before parsing, so the schema only sees real values.
 */
export const paginationQuerySchema = z.object({
  /** Opaque cursor from the previous page (`nextCursor`); absent = first page. */
  cursor: z.string().min(1).optional(),
  /** Page size; defaults to 200 and never exceeds 200. */
  limit: z.coerce.number().int().min(PAGINATION_MIN_LIMIT).max(PAGINATION_MAX_LIMIT).optional(),
});

/** Parsed `?cursor=` / `?limit=` pair. */
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** One keyset page: the rows plus the cursor for the next page (null = end). */
export interface PagedRows<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Envelope schema for a keyset page of `rowSchema`. The legacy bare arrays
 * keep their own schemas (`patientListSchema`, ...); this factory only types
 * the opt-in paged shape so the two never drift silently.
 */
export function pagedListSchema<T extends z.ZodTypeAny>(rowSchema: T) {
  return z.object({
    rows: z.array(rowSchema),
    nextCursor: z.string().nullable(),
  });
}

/**
 * Encodes one ordering key as an opaque cursor: base64url of the JSON object,
 * e.g. `{"createdAt":"...","id":"..."}`. Callers never build or read the
 * payload by hand — they pass `nextCursor` back as `?cursor=` unchanged.
 */
export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque cursor back to its ordering key. Throws (never returns a
 * partial object) on any malformed input: bad base64url, non-JSON, a JSON
 * array, or an object with no string values. The API maps the throw to a 400
 * `validation.failed`; the message carries no tenant data.
 */
export function decodeCursor(cursor: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid pagination cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid pagination cursor');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') throw new Error('Invalid pagination cursor');
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw new Error('Invalid pagination cursor');
  return out;
}

/**
 * Normalizes a raw `?limit=` query value: absent/empty uses the default,
 * a value above the max is clamped to it, anything else outside
 * `1..200` (zero, negative, NaN, fractional) throws for a 400.
 */
export function parsePageLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return PAGINATION_DEFAULT_LIMIT;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < PAGINATION_MIN_LIMIT) {
    throw new Error('Invalid pagination limit');
  }
  return Math.min(parsed, PAGINATION_MAX_LIMIT);
}

/**
 * True when the caller asked for keyset pagination: a non-empty `?cursor=`
 * or a present `?limit=`. With neither, the endpoint answers the legacy bare
 * array (capped at 200) and the behavior is byte-for-byte the old one.
 */
export function wantsKeysetPage(query: { cursor?: unknown; limit?: unknown }): boolean {
  const cursor = typeof query.cursor === 'string' ? query.cursor.trim() : '';
  const limit = query.limit;
  return cursor !== '' || (limit !== undefined && limit !== null && String(limit).trim() !== '');
}
