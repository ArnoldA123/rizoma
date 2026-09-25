// Obras operation contracts — equipment, warehouse stock, budget/progress and
// the site log (W5).
//
// Row-for-row mirror of `apps/api/src/obras/resources.service.ts`, which is the
// only module that talks to the four tables of `005_obras.sql` (`assets`,
// `asset_readings`, `inventory_items`, `stock_moves`, `budget_lines`,
// `progress_entries`, `milestones`, `site_logs`). Same three conventions as the
// rest of the package: camelCase keys as the row mappers emit them, a plain
// string for every status (the database CHECK owns the state machine) and
// `string | null` for every optional timestamp.
//
// The status catalogs below are copies of the CHECK constraints, not of the
// service's prose, because a form has to offer exactly the values the column
// accepts. The bodies mirror the service parsers field by field, defaults
// included: the service applies `minStock = 0`, `qtyPlanned = 0`, `unitCost = 0`,
// `siteId = null`, `itemId = null`, `budgetLineId = null`, `attachmentIds = []`
// and `source = 'manual'` when the field is absent, so a form that omits them
// produces exactly the row the service would.
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';

// ============ records ============

/** One equipment unit (`assets`), as `POST /v1/obras/assets` answers it. */
export const assetRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  code: z.string(),
  kind: z.string(),
  serial: z.string(),
  /** `available` / `assigned` / `maintenance` / `retired`. */
  status: z.string(),
  /** Site the unit is assigned to; `null` when it is not in a site. */
  currentSiteId: uuidSchema.nullable(),
});

export type AssetRecord = z.infer<typeof assetRecordSchema>;

/** One manual reading (`asset_readings`, insert-only). */
export const assetReadingRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  assetId: uuidSchema,
  /** Free label; the UI's manual flow writes `horometro`. */
  kind: z.string(),
  value: z.number(),
  at: isoValueSchema,
  /** `manual` unless the caller sent something else. */
  source: z.string(),
});

export type AssetReadingRecord = z.infer<typeof assetReadingRecordSchema>;

/** One warehouse item (`inventory_items`). */
export const inventoryItemRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  minStock: z.number(),
  active: z.boolean(),
});

export type InventoryItemRecord = z.infer<typeof inventoryItemRecordSchema>;

/** One warehouse move (`stock_moves`), posted in a single step. */
export const stockMoveRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  itemId: uuidSchema,
  /** Org node of the warehouse the move is booked against. */
  warehouseNodeId: uuidSchema,
  /** Site the consumption is charged to; `null` for a pure warehouse entry. */
  siteId: uuidSchema.nullable(),
  qty: z.number(),
  /** `in` / `out` / `transfer`. */
  kind: z.string(),
  at: isoValueSchema,
  /** `draft` / `posted` / `reversed`. */
  status: z.string(),
});

export type StockMoveRecord = z.infer<typeof stockMoveRecordSchema>;

/** One budget line of a site (`budget_lines`). */
export const budgetLineRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  siteId: uuidSchema,
  /** Optional catalogue item the line refers to. */
  itemId: uuidSchema.nullable(),
  description: z.string(),
  qtyPlanned: z.number(),
  unitCost: z.number(),
  active: z.boolean(),
});

export type BudgetLineRecord = z.infer<typeof budgetLineRecordSchema>;

/** One executed quantity (`progress_entries`), posted on creation. */
export const progressEntryRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  siteId: uuidSchema,
  budgetLineId: uuidSchema.nullable(),
  qtyDone: z.number(),
  at: isoValueSchema,
  /** Token subject that reported it — the service, never the request body. */
  reportedBy: uuidSchema,
  /** `draft` / `posted`; the endpoint inserts directly as `posted`. */
  status: z.string(),
});

export type ProgressEntryRecord = z.infer<typeof progressEntryRecordSchema>;

/** `GET /v1/obras/progress/entries?site=` — the API caps lists at 200 rows. */
export const progressEntryListSchema = z.array(progressEntryRecordSchema);
export type ProgressEntryList = z.infer<typeof progressEntryListSchema>;

/** One milestone (`milestones`); `late` is decided by Postgres' clock. */
export const milestoneRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  siteId: uuidSchema,
  name: z.string(),
  dueAt: isoValueSchema,
  /** `pending` / `done` / `late`. */
  status: z.string(),
});

export type MilestoneRecord = z.infer<typeof milestoneRecordSchema>;

/**
 * One site log (`site_logs`). `attachmentIds` is metadata only: MVP1 exposes no
 * file endpoints, so the service stores the identifiers and the UI says so
 * instead of offering a broken upload.
 */
export const siteLogRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  siteId: uuidSchema,
  authorId: uuidSchema,
  text: z.string(),
  attachmentIds: z.array(z.string()),
  at: isoValueSchema,
  /** `draft` / `published`. */
  status: z.string(),
});

export type SiteLogRecord = z.infer<typeof siteLogRecordSchema>;

/** `GET /v1/obras/sites/:siteId/logs` — the API caps lists at 200 rows. */
export const siteLogListSchema = z.array(siteLogRecordSchema);
export type SiteLogList = z.infer<typeof siteLogListSchema>;

// ============ status catalogs (CHECK constraints of 005_obras.sql) ============

/** `assets.status`, in the order the state machine advances. */
export const ASSET_STATUSES = ['available', 'assigned', 'maintenance', 'retired'] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

/** `stock_moves.kind`. */
export const STOCK_MOVE_KINDS = ['in', 'out', 'transfer'] as const;
export const stockMoveKindSchema = z.enum(STOCK_MOVE_KINDS);
export type StockMoveKind = z.infer<typeof stockMoveKindSchema>;

/** `stock_moves.status`; a reversal never deletes the original row. */
export const STOCK_MOVE_STATUSES = ['draft', 'posted', 'reversed'] as const;
export const stockMoveStatusSchema = z.enum(STOCK_MOVE_STATUSES);
export type StockMoveStatus = z.infer<typeof stockMoveStatusSchema>;

/** `site_logs.status`. */
export const SITE_LOG_STATUSES = ['draft', 'published'] as const;
export const siteLogStatusSchema = z.enum(SITE_LOG_STATUSES);
export type SiteLogStatus = z.infer<typeof siteLogStatusSchema>;

/** `milestones.status`; `late` is set by the database, never by the client. */
export const MILESTONE_STATUSES = ['pending', 'done', 'late'] as const;
export const milestoneStatusSchema = z.enum(MILESTONE_STATUSES);
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;

// ============ request bodies ============

/** `assets.kind` is free text in the API; this is a suggestion list, not a rule. */
export const ASSET_KIND_SUGGESTIONS: readonly string[] = [
  'maquinaria',
  'herramienta',
  'vehiculo',
  'equipo_menor',
];

/** `asset_readings.kind` default of the manual form (a horómetro reading). */
export const ASSET_READING_KIND_HOROMETER = 'horometro';

/** Reading kinds the manual form offers; the column itself is free text. */
export const ASSET_READING_KIND_SUGGESTIONS: readonly string[] = [
  ASSET_READING_KIND_HOROMETER,
  'kilometraje',
  'otro',
];

/** UI caps; the API itself only requires a non-empty text. */
export const ASSET_CODE_MAX = 32;
export const ASSET_KIND_MAX = 60;
export const ASSET_SERIAL_MAX = 60;
export const ITEM_SKU_MAX = 32;
export const ITEM_NAME_MAX = 120;
export const ITEM_UNIT_MAX = 16;
export const BUDGET_LINE_DESCRIPTION_MAX = 160;
export const MILESTONE_NAME_MAX = 120;
export const SITE_LOG_TEXT_MAX = 2000;

/** Body of `POST /v1/obras/assets` (`site.write`, at the target org node). */
export const assetCreateInputSchema = z.object({
  /** Org node the unit belongs to; the catalogue is a site plan, not a site row. */
  orgNodeId: uuidSchema,
  code: z.string().min(1),
  kind: z.string().min(1),
  serial: z.string().min(1),
});

export type AssetCreateInput = z.infer<typeof assetCreateInputSchema>;

/** Body of `POST /v1/obras/assets/:id/assign` (`assignment.write`). */
export const assetAssignInputSchema = z.object({
  siteId: uuidSchema,
});

export type AssetAssignInput = z.infer<typeof assetAssignInputSchema>;

/**
 * Body of `POST /v1/obras/assets/:id/readings` (`attendance.mark` plus an
 * active assignment, unless the caller is an org-scoped manager).
 *
 * `source` is the *origin* of the reading (a manual entry, an import), not the
 * asset; it defaults to `manual` exactly as the service does.
 */
export const assetReadingInputSchema = z.object({
  kind: z.string().min(1),
  /** Non-negative and finite; the service refuses anything else with a 400. */
  value: z.number().nonnegative(),
  source: z.string().min(1).default('manual'),
});

export type AssetReadingInput = z.input<typeof assetReadingInputSchema>;

/** Body of `POST /v1/obras/stock/items` (`stock.consume`, company scope). */
export const itemCreateInputSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1),
  minStock: z.number().nonnegative().default(0),
});

export type ItemCreateInput = z.input<typeof itemCreateInputSchema>;

/**
 * Body of `POST /v1/obras/stock/moves` (`stock.consume`).
 *
 * `qty` is strictly positive: the service refuses `0` with a 400 (`at least` vs
 * `greater than 0`). An `out` or a `transfer` that exceeds the item's *posted*
 * quantity at the warehouse is refused with `obra.insufficient_stock`, which is
 * the check the "consumo descuenta" acceptance criterion is about.
 */
export const stockMoveInputSchema = z.object({
  itemId: uuidSchema,
  warehouseNodeId: uuidSchema,
  /** Site the consumption is charged to; `null` for a plain warehouse entry. */
  siteId: uuidSchema.nullable().default(null),
  qty: z.number().positive(),
  kind: stockMoveKindSchema,
});

export type StockMoveInput = z.input<typeof stockMoveInputSchema>;

/** Body of `POST /v1/obras/progress/budget-lines` (`site.write`). */
export const budgetLineCreateInputSchema = z.object({
  siteId: uuidSchema,
  itemId: uuidSchema.nullable().default(null),
  description: z.string().min(1),
  qtyPlanned: z.number().nonnegative().default(0),
  unitCost: z.number().nonnegative().default(0),
});

export type BudgetLineCreateInput = z.input<typeof budgetLineCreateInputSchema>;

/**
 * Body of `POST /v1/obras/progress/entries` (`attendance.mark` plus the site
 * key). A `budgetLineId` that belongs to another site is a 400, so the form
 * pre-selects the lines it read from this same site.
 */
export const progressEntryCreateInputSchema = z.object({
  siteId: uuidSchema,
  budgetLineId: uuidSchema.nullable().default(null),
  qtyDone: z.number().nonnegative(),
});

export type ProgressEntryCreateInput = z.input<typeof progressEntryCreateInputSchema>;

/**
 * Body of `POST /v1/obras/progress/milestones` (`site.write`).
 *
 * `dueAt` is accepted as any string `Date.parse` can read (the service validates
 * with the same call) and is then cast by Postgres to `timestamptz`; the status
 * is decided there, so a past date comes back as `late` and not as an error.
 */
export const milestoneCreateInputSchema = z.object({
  siteId: uuidSchema,
  name: z.string().min(1),
  dueAt: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Expected a parseable ISO timestamp',
  }),
});

export type MilestoneCreateInput = z.infer<typeof milestoneCreateInputSchema>;

/**
 * Body of `POST /v1/obras/sites/:siteId/logs` (`attendance.mark`, on-site).
 *
 * The POST route does not accept `status`: a log is always created as `draft`
 * and published through its own endpoint. `attachmentIds` are metadata only
 * (MVP1 has no file endpoints), so the UI collects identifiers and states that
 * no file travels with them.
 */
export const siteLogCreateInputSchema = z.object({
  text: z.string().min(1),
  attachmentIds: z.array(uuidSchema).default([]),
});

export type SiteLogCreateInput = z.input<typeof siteLogCreateInputSchema>;

// ============ read-path query helpers ============

/** Query of `GET /v1/obras/progress/entries`. */
export interface ProgressEntriesQuery {
  /** Site to list; required by the service (an empty value is a 400). */
  readonly site?: string;
}

/**
 * Query string of `GET /v1/obras/progress/entries`, `?` included and an empty
 * `site` omitted. The controller reads `?site=` and the service refuses a
 * missing or malformed identifier, so an empty field here is a *missing*
 * parameter and never a default: the screen must name the site it is reading.
 */
export function progressEntriesQueryString(query: ProgressEntriesQuery = {}): string {
  if (query.site === undefined || query.site === '') return '';
  return `?site=${encodeURIComponent(query.site)}`;
}

// ============ state-machine helpers (mirrors of the service) ============

/**
 * Signed effect of one move on the warehouse's posted stock. Mirrors the
 * `SUM(CASE WHEN kind = 'in' THEN qty ELSE -qty END)` of `AVAILABLE_STOCK_SQL`
 * and the critical-stock query, so a screen can label a row `+2` / `-3` without
 * inventing a second arithmetic.
 *
 * It is deliberately *not* an availability calculator: the API aggregates the
 * posted rows inside the scope, and a partial list summed on the client would
 * report a quantity nobody computed.
 */
export function stockMoveSignedQty(move: Pick<StockMoveRecord, 'kind' | 'qty'>): number {
  return move.kind === 'in' ? move.qty : -move.qty;
}

/** `true` when the unit may be assigned: only `available` may (`obra.asset_unavailable`). */
export function assetCanBeAssigned(status: string): boolean {
  return status === 'available';
}

/**
 * `true` when a reading may be appended. The service refuses a `retired` unit
 * with `obra.asset_unavailable` and accepts every other state, so a
 * maintenance unit is still readable.
 */
export function assetCanBeRead(status: string): boolean {
  return status !== 'retired';
}

/** `true` for a log that is still a draft and can therefore be published. */
export function siteLogIsDraft(log: Pick<SiteLogRecord, 'status'>): boolean {
  return log.status === 'draft';
}

/** `true` for a posted move; only a posted move can be reversed. */
export function stockMoveCanBeReversed(move: Pick<StockMoveRecord, 'status'>): boolean {
  return move.status === 'posted';
}
