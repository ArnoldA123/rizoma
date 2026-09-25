// Saved-view contracts — `POST/GET/PATCH/DELETE /v1/views` (B1).
//
// A saved view is a named-less, owner-scoped bag of exact-equality filters for
// one list entity (`patients`, `appointments`, `invoices`, `attendance`). The
// table (`db/migrations/001_core_foundation.sql:226-233`) carries no GIN index
// on `filters`, so the API applies them as parameterized `col = $n` equality
// predicates over the already scope-capped (<=200 rows) list queries — a
// sequential scan over that page is the documented limit, not a silent one.
// There is no visual editor and no drag-and-drop: the web form edits flat
// key/value pairs (or raw JSON) validated here.
//
// Runner: `node --test src/views.test.ts` (type stripping).
import { z } from 'zod';
import { uuidSchema } from './common.ts';

/** List entities a view may target — a closed list, never free text. */
export const savedViewEntitySchema = z.enum(['patients', 'appointments', 'invoices', 'attendance']);

export type SavedViewEntity = z.infer<typeof savedViewEntitySchema>;

/** Every entity the contract accepts, in declaration order. */
export const SAVED_VIEW_ENTITIES = savedViewEntitySchema.options;

/** Hard cap on filter entries per view (form + JSONB bag stay reviewable). */
export const MAX_SAVED_VIEW_FILTERS = 20;

/** Longest filter key or string value the contract carries. */
export const MAX_SAVED_VIEW_TEXT_LENGTH = 200;

/**
 * Exact-equality filter keys each entity accepts. The API maps every key to
 * one physical column (`views.service.ts: SAVED_VIEW_FILTER_COLUMNS`) and
 * rejects anything else, so this map and that one change in the same work
 * unit — never a silent drift.
 */
export const SAVED_VIEW_FILTER_KEYS: Record<SavedViewEntity, readonly string[]> = {
  patients: ['active', 'documentType', 'documentNumber', 'orgNodeId'],
  appointments: ['status', 'patientId', 'professionalId', 'orgNodeId'],
  invoices: ['status', 'cashSessionId', 'serie', 'customerDocNumber', 'fiscalStatus'],
  attendance: ['status', 'siteId', 'userId', 'source'],
};

/** Every filter key the contract knows, across entities (PATCH pre-check). */
export const ALL_SAVED_VIEW_FILTER_KEYS: readonly string[] = [
  ...new Set(Object.values(SAVED_VIEW_FILTER_KEYS).flat()),
];

/** Key shape: `camelCase` identifier, so it maps 1:1 to a record field. */
const savedViewFilterKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'Filter keys must be camelCase identifiers');

/** One exact-equality value: scalar only, no nesting, no operators. */
export const savedViewFilterValueSchema = z.union([
  z.string().max(MAX_SAVED_VIEW_TEXT_LENGTH),
  z.number().finite(),
  z.boolean(),
]);

export type SavedViewFilterValue = z.infer<typeof savedViewFilterValueSchema>;

/**
 * Flat bag of exact-equality filters. Operators (`$gt`, `$in`, …), nested
 * objects and arrays are rejected: without a GIN index they would read as
 * supported while scanning, so the contract refuses them loudly instead.
 */
export const savedViewFiltersSchema = z
  .record(z.string(), savedViewFilterValueSchema)
  .refine((filters) => Object.keys(filters).length <= MAX_SAVED_VIEW_FILTERS, {
    message: `filters must hold at most ${MAX_SAVED_VIEW_FILTERS} entries`,
  });

export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>;

/** Keys of `entity` known to the contract (error message lists them). */
function allowedKeysMessage(entity: SavedViewEntity): string {
  return `Unknown filter key for ${entity}: expected one of ${SAVED_VIEW_FILTER_KEYS[entity].join(', ')}`;
}

/** Rejects well-shaped keys the target entity cannot apply. */
function checkEntityKeys(
  entity: SavedViewEntity,
  filters: SavedViewFilters,
  ctx: z.RefinementCtx,
): void {
  const allowed = SAVED_VIEW_FILTER_KEYS[entity];
  for (const key of Object.keys(filters)) {
    if (!savedViewFilterKeySchema.safeParse(key).success || !allowed.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: allowedKeysMessage(entity),
        path: ['filters', key],
      });
    }
  }
}

/** `POST /v1/views` — store one filter bag for one entity. */
export const savedViewCreateInputSchema = z
  .object({
    /** List the filters apply to; the API resolves `?saved_view_id=` only there. */
    entity: savedViewEntitySchema,
    /** Exact-equality bag; `{}` means "no filters". */
    filters: savedViewFiltersSchema.default({}),
    /** `true` makes the view visible to every role of the same tenant. */
    shared: z.boolean().default(false),
  })
  .superRefine((input, ctx) => checkEntityKeys(input.entity, input.filters, ctx));

export type SavedViewCreateInput = z.input<typeof savedViewCreateInputSchema>;

/** `PATCH /v1/views/:id` — owner only; at least one field is required. */
export const savedViewUpdateInputSchema = z
  .object({
    entity: savedViewEntitySchema.optional(),
    filters: savedViewFiltersSchema.optional(),
    shared: z.boolean().optional(),
    /** `DELETE` answers with `active: false`; PATCH may set it back to `true`. */
    active: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.entity === undefined &&
      input.filters === undefined &&
      input.shared === undefined &&
      input.active === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Body must include at least one of entity, filters, shared or active',
      });
      return;
    }
    // Without `entity`, the keys can only be pre-checked against the union;
    // the service re-validates them against the stored entity in all cases.
    if (input.filters !== undefined) {
      if (input.entity !== undefined) {
        checkEntityKeys(input.entity, input.filters, ctx);
      } else {
        for (const key of Object.keys(input.filters)) {
          if (
            !savedViewFilterKeySchema.safeParse(key).success ||
            !ALL_SAVED_VIEW_FILTER_KEYS.includes(key)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Unknown filter key: expected one of ${ALL_SAVED_VIEW_FILTER_KEYS.join(', ')}`,
              path: ['filters', key],
            });
          }
        }
      }
    }
  });

export type SavedViewUpdateInput = z.input<typeof savedViewUpdateInputSchema>;

/** One saved view as the API returns it. */
export const savedViewRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  /** Owner; `null` rows are legacy/global rows: visible, never API-mutable. */
  userId: uuidSchema.nullable(),
  entity: savedViewEntitySchema,
  filters: savedViewFiltersSchema,
  shared: z.boolean(),
  active: z.boolean(),
});

export type SavedViewRecord = z.infer<typeof savedViewRecordSchema>;

/** `GET /v1/views` — own active views plus `shared` ones, tenant-scoped. */
export const savedViewListSchema = z.array(savedViewRecordSchema);

export type SavedViewList = z.infer<typeof savedViewListSchema>;

/** Query of `GET /v1/views` — optional entity narrowing, nothing else. */
export interface SavedViewsQuery {
  readonly entity?: string;
}

/**
 * Query string of `GET /v1/views`, `?` included and empty fields omitted. An
 * unknown entity is *not* defaulted here: the API answers 400, so a typo is
 * loud instead of silently listing everything.
 */
export function savedViewsQueryString(query: SavedViewsQuery = {}): string {
  if (query.entity === undefined || query.entity === '') return '';
  return `?entity=${encodeURIComponent(query.entity)}`;
}

/**
 * Query suffix carrying a saved view into an existing listing
 * (`GET /v1/salud/patients?saved_view_id=…`, …). Empty ids produce no suffix;
 * the listing treats a missing view as 404 and an entity mismatch as 400.
 */
export function savedViewIdQueryString(savedViewId: string | null | undefined): string {
  if (savedViewId === null || savedViewId === undefined || savedViewId === '') return '';
  return `?saved_view_id=${encodeURIComponent(savedViewId)}`;
}
