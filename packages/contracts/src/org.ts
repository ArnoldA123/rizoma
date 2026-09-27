// Org contracts — row shapes of `apps/api/src/org/org.service.ts`.
//
// The org tree (`org_nodes` in `db/migrations/001_core_foundation.sql`) is the
// scope backbone every guard reads, but until P2 it had no read endpoint: the
// P2 selectors (sede, area, obra) need `{id, name}` pairs with their kind, so
// this module mirrors the listing shapes. The API never exposes timestamps or
// tenant internals here — only the fields a selector renders or filters by.
import { z } from 'zod';
import { uuidSchema } from './common.ts';
import { pagedListSchema, paginationQuerySchema } from './pagination.ts';

/**
 * `org_nodes.kind` — the CHECK of `001_core_foundation.sql`, in the API's own
 * order. The service refuses an unknown `?kind=` with a 400, so the screen
 * filters only with these values.
 */
export const ORG_NODE_KINDS = [
  'empresa',
  'sede',
  'sucursal',
  'area',
  'proyecto',
  'obra',
  'especialidad',
] as const;

export const orgNodeKindSchema = z.enum(ORG_NODE_KINDS);
export type OrgNodeKind = z.infer<typeof orgNodeKindSchema>;

/**
 * Fallback sede zone (P4-1a): every board resolves "today" in the sede's
 * zone, and a node with no usable zone reads as Lima. The API mirrors this
 * constant in its own module so the runtime has no cross-package import;
 * the values must stay `America/Lima` on both sides.
 */
export const DEFAULT_ORG_TIMEZONE = 'America/Lima';

/** True when `value` is a usable IANA timezone (backed by `Intl`). */
export function isValidIanaTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** IANA timezone of the sede (P4-1a, `org_nodes.timezone` in migration 010). */
export const orgTimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => isValidIanaTimezone(value), 'Expected an IANA timezone');

/** One org tree node timezone, or the Lima fallback when the row has none. */
export function normalizeOrgTimezone(value: unknown): string {
  return isValidIanaTimezone(value) ? (value as string) : DEFAULT_ORG_TIMEZONE;
}

/** `GET /v1/org/nodes` — one org tree node. */
export const orgNodeRecordSchema = z.object({
  id: uuidSchema,
  /** Parent node, or `null` for the company root. */
  parentId: uuidSchema.nullable(),
  kind: z.string(),
  name: z.string(),
  active: z.boolean(),
  /**
   * IANA timezone of the sede (P4-1a). Optional on the wire so pre-010
   * payloads still parse; producers always send it and consumers fall back
   * to `DEFAULT_ORG_TIMEZONE` when it is absent.
   */
  timezone: orgTimezoneSchema.optional(),
});

export type OrgNodeRecord = z.infer<typeof orgNodeRecordSchema>;

/**
 * `GET /v1/org/nodes` — bare array capped at 200 (legacy path, no cursor).
 * Newest-first does not apply here: the listing answers `name ASC, id ASC`
 * so a selector renders alphabetically.
 */
export const orgNodeListSchema = z.array(orgNodeRecordSchema);
export type OrgNodeList = z.infer<typeof orgNodeListSchema>;

/**
 * Query filters of `GET /v1/org/nodes`, field-for-field what the service
 * parser accepts: the node kind, the activation flag and the parent node.
 * Every field is optional and an empty string counts as absent.
 */
export const orgNodeListQuerySchema = z.object({
  kind: z.string().min(1).nullable().optional(),
  active: z.boolean().nullable().optional(),
  parent: uuidSchema.nullable().optional(),
});
export type OrgNodeListQuery = z.infer<typeof orgNodeListQuerySchema>;

/** Keyset query (`?cursor=` / `?limit=`) shared with every R1 listing. */
export const orgNodePageQuerySchema = paginationQuerySchema;
export type OrgNodePageQuery = z.infer<typeof orgNodePageQuerySchema>;

/** Keyset page of `GET /v1/org/nodes` (`{rows, nextCursor}`). */
export const orgNodePagedSchema = pagedListSchema(orgNodeRecordSchema);
export type OrgNodePaged = z.infer<typeof orgNodePagedSchema>;
