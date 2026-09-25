// Obras resources service — equipment, warehouse stock, budget/progress and the
// site log (bases-consolidadas-v1.md §2.4, §3.1, §3.4, §4.4).
//
// Same split as `obras.service.ts`: a plain module with no decorators, so the
// suite loads it under Node's strip-only TypeScript, and the controllers stay a
// thin HTTP skin. This file owns the O3 use cases — assets and manual readings,
// warehouse items and stock moves, budget lines, progress entries, milestones
// and the site log — and reuses the O2 access model:
//   1. build the guard facts (membership, org-node subtree, tenant module);
//   2. evaluate the central rule through `canActivate` with the closest
//      existing policy action, refusing on denial and auditing it as
//      `access.denied`;
//   3. layer the construction key on top of on-site field writes: an active
//      assignment, or a manager whose membership subtree already covers the
//      site (`gerente`, `jefe_obra`);
//   4. run tenant-scoped, fully parameterized SQL (RLS already bound the
//      request transaction) and append one `audit_log` row per accepted write.
//
// Policy reuse is deliberate: the demo matrix (§3.4) declares only twelve
// actions and none of them names this vertical's resources, so the closest
// existing codes are reused — `site.write` for the site plan (asset catalogue,
// budget lines, milestones), `assignment.write` to assign an asset to a site,
// `stock.consume` for the warehouse (items, moves, reversals and the
// `almacen` role) and `attendance.mark` as the generic on-site field write
// (readings, progress, site log). The missing dedicated actions
// (`asset.write`, `stock.write`, `progress.write`, `site_log.write`) are a
// documented follow-up, not a change made here.
//
// State machines kept in this module:
//   assets:       available → assigned → (maintenance) → retired
//                 (only `available` may be assigned; `maintenance`/`retired`
//                 answer `obra.asset_unavailable`)
//   stock_moves:  draft → posted → reversed (reverse never deletes a row)
//   progress:     draft → posted (`postProgress` inserts directly as posted)
//   site_logs:    draft → published
//   milestones:   late when the due date is already in the past, else pending
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import {
  OBRA_LIST_LIMIT,
  OBRA_MODULE,
  activeAssignment,
  type ObraActorContext,
  type ObraClient,
  type SiteRecord,
} from './obras.service.ts';

/** Tenant module this vertical requires (§3.1 property 6 / §3.5). */
export { OBRA_MODULE };

/** Rows the list endpoints return at most; keeps a stray wide scan bounded. */
export const OBRA_RESOURCE_LIST_LIMIT = OBRA_LIST_LIMIT;

/** Timestamped value (`timestamptz`/`date`) normalized to a plain string. */
type IsoValue = string | null;

/**
 * Roles that reach a site without an assignment because their membership
 * subtree already bounds them to it. Mirrors the O2 key in `obras.service.ts`.
 */
const ORG_SCOPED_SITE_ROLES: readonly string[] = ['gerente', 'jefe_obra'];

// ============ value coercion ============

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

/** `pg` returns NUMERIC as string; normalize to a finite number. */
function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = readString(item);
    if (text !== undefined) out.push(text);
  }
  return out;
}

function toIso(value: unknown): IsoValue {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============ error envelope ============

/** 403 envelope when the caller has no reachable site (scope or assignment). */
function scopeDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.scope_denied', message: `Site access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 409 envelope when an asset is not in a state that allows the transition. */
function assetUnavailable(reason: string, traceId: string): HttpException {
  return new HttpException(
    {
      code: 'obra.asset_unavailable',
      message: `Asset unavailable for this operation: ${reason}`,
      reason,
      traceId,
    },
    409,
  );
}

/** 409 envelope when an `out`/`transfer`/reversal would leave negative stock. */
function insufficientStock(message: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.insufficient_stock', message, traceId },
    409,
  );
}

/** 409 envelope for an invalid state transition (publish, reverse, ...). */
function stateDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.state_denied', message: `Invalid state transition: ${reason}`, reason, traceId },
    409,
  );
}

/** 409 envelope for a business key already taken in the tenant. */
function duplicate(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'obra.duplicate', message, traceId }, 409);
}

/** 400 envelope for a body/param that fails validation. */
function badRequest(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'validation.failed', message, traceId }, 400);
}

/** 404 envelope for an entity that does not exist in the tenant. */
function notFound(entity: string, traceId: string): HttpException {
  return new HttpException({ code: 'not_found', message: `${entity} not found`, traceId }, 404);
}

// ============ guard facts ============

interface ActorFacts {
  readonly membership: MembershipRecord | null;
  readonly scopeSubtree: readonly string[];
  readonly moduleActive: boolean;
}

const SELECT_TENANT_MODULES_SQL = 'SELECT modules FROM tenants WHERE id = $1';

async function tenantHasModule(
  client: ObraClient,
  tenantId: string,
  module: string,
): Promise<boolean> {
  const result = await client.query(SELECT_TENANT_MODULES_SQL, [tenantId]);
  const modules = readRows(result)[0]?.modules;
  return Array.isArray(modules) && modules.includes(module);
}

const SELECT_SUBTREE_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM org_nodes WHERE tenant_id = $1 AND id = $2
  UNION ALL
  SELECT n.id FROM org_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.tenant_id = $1
)
SELECT id FROM subtree`;

async function loadScopeSubtree(
  client: ObraClient,
  tenantId: string,
  rootId: string,
): Promise<string[]> {
  const result = await client.query(SELECT_SUBTREE_SQL, [tenantId, rootId]);
  const ids: string[] = [];
  for (const row of readRows(result)) {
    if (typeof row.id === 'string') ids.push(row.id);
  }
  return ids;
}

async function loadFacts(actor: ObraActorContext): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await tenantHasModule(actor.client, actor.tenantId, OBRA_MODULE);
  return { membership, scopeSubtree, moduleActive };
}

interface AuthorizeOptions {
  readonly action: ActionCode;
  readonly entity: string;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly stateAllows?: boolean;
  readonly attemptedAction?: string;
}

/**
 * Runs the single central rule and audits a denial (through `canActivate`).
 * Returns the membership on allow; throws the shared `obra.scope_denied`
 * envelope on deny.
 */
async function authorize(
  actor: ObraActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions,
): Promise<MembershipRecord> {
  const rolePermits =
    facts.membership !== null && rolePermitsAction(facts.membership.role, options.action);
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: actor.roles, scope: [] },
    membership: facts.membership,
    entityOrgNodeId: options.orgNodeId,
    scopeSubtree: [...facts.scopeSubtree],
    rolePermits,
    stateAllows: options.stateAllows ?? true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: options.entity,
      entityId: options.entityId ?? null,
      orgNodeId: options.orgNodeId,
      attemptedAction: options.attemptedAction ?? options.action,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw scopeDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ write + denial audit ============

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

const INSERT_DENIAL_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, 'access.denied', $3, $4, $5, $6::jsonb, $7)`;

interface AuditEntry {
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly orgNodeId: string;
  readonly diff: Record<string, unknown>;
}

/** Appends one row per successful write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: ObraActorContext,
  membership: MembershipRecord,
  entry: AuditEntry,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    entry.action,
    entry.entity,
    entry.entityId,
    entry.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...entry.diff }),
    actor.ip,
  ]);
}

interface DenialEntry {
  readonly reason: string;
  readonly entity: string;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly attemptedAction: string;
}

/** Writes the `access.denied` row for a denial the central rule did not see. */
async function deny(
  actor: ObraActorContext,
  error: HttpException,
  entry: DenialEntry,
): Promise<never> {
  await actor.client.query(INSERT_DENIAL_SQL, [
    actor.tenantId,
    actor.userId,
    entry.entity,
    entry.entityId ?? null,
    entry.orgNodeId,
    JSON.stringify({
      traceId: actor.traceId,
      reason: entry.reason,
      attemptedAction: entry.attemptedAction,
      role: null,
    }),
    actor.ip,
  ]);
  throw error;
}

// ============ constraint mapping ============

const SQLSTATE_UNIQUE_VIOLATION = '23505';
const SQLSTATE_FK_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Runs an insert on the *new* tables and maps the two client-caused constraint
 * failures onto typed 4xx envelopes. `assets.code`, `inventory_items.sku` and
 * the rest of the new unique keys answer `obra.duplicate`; a dangling reference
 * (e.g. an unknown site or item) answers 400.
 */
async function insertResource(
  actor: ObraActorContext,
  duplicateMessage: string,
  run: () => Promise<unknown>,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return readRows(await run());
  } catch (error) {
    const state = sqlState(error);
    if (state === SQLSTATE_UNIQUE_VIOLATION) throw duplicate(duplicateMessage, actor.traceId);
    if (state === SQLSTATE_FK_VIOLATION) {
      throw badRequest('Referenced entity does not exist', actor.traceId);
    }
    throw error;
  }
}

// ============ body validation ============

function requireString(body: Record<string, unknown>, key: string, traceId: string): string {
  const value = readString(body[key])?.trim();
  if (value === undefined || value === '') throw badRequest(`Missing required field: ${key}`, traceId);
  return value;
}

function requireUuid(body: Record<string, unknown>, key: string, traceId: string): string {
  const value = requireString(body, key, traceId);
  if (!UUID_RE.test(value)) throw badRequest(`Invalid UUID in field: ${key}`, traceId);
  return value;
}

function optionalUuid(body: Record<string, unknown>, key: string, traceId: string): string | null {
  if (body[key] === undefined || body[key] === null) return null;
  return requireUuid(body, key, traceId);
}

function requireUuidParam(value: string, label: string, traceId: string): string {
  const trimmed = value?.trim() ?? '';
  if (!UUID_RE.test(trimmed)) throw badRequest(`Invalid ${label}`, traceId);
  return trimmed;
}

interface NumberRule {
  readonly min?: number;
  readonly exclusiveMin?: boolean;
}

function requireNumber(
  body: Record<string, unknown>,
  key: string,
  traceId: string,
  rule: NumberRule = {},
): number {
  const raw = body[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw badRequest(`Field ${key} must be a finite number`, traceId);
  }
  const min = rule.min ?? 0;
  if (rule.exclusiveMin === true ? raw <= min : raw < min) {
    throw badRequest(`Field ${key} must be ${rule.exclusiveMin === true ? 'greater than' : 'at least'} ${min}`, traceId);
  }
  return raw;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  traceId: string,
  fallback: number,
  rule: NumberRule = {},
): number {
  if (body[key] === undefined || body[key] === null) return fallback;
  return requireNumber(body, key, traceId, rule);
}

// ============ row shapes ============

export interface AssetRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  code: string;
  kind: string;
  serial: string;
  status: string;
  currentSiteId: string | null;
}

export interface AssetReadingRecord {
  id: string;
  tenantId: string;
  assetId: string;
  kind: string;
  value: number;
  at: IsoValue;
  source: string;
}

export interface InventoryItemRecord {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  unit: string;
  minStock: number;
  active: boolean;
}

export interface StockMoveRecord {
  id: string;
  tenantId: string;
  itemId: string;
  warehouseNodeId: string;
  siteId: string | null;
  qty: number;
  kind: string;
  at: IsoValue;
  status: string;
}

export interface BudgetLineRecord {
  id: string;
  tenantId: string;
  siteId: string;
  itemId: string | null;
  description: string;
  qtyPlanned: number;
  unitCost: number;
  active: boolean;
}

export interface ProgressEntryRecord {
  id: string;
  tenantId: string;
  siteId: string;
  budgetLineId: string | null;
  qtyDone: number;
  at: IsoValue;
  reportedBy: string;
  status: string;
}

export interface MilestoneRecord {
  id: string;
  tenantId: string;
  siteId: string;
  name: string;
  dueAt: IsoValue;
  status: string;
}

export interface SiteLogRecord {
  id: string;
  tenantId: string;
  siteId: string;
  authorId: string;
  text: string;
  attachmentIds: string[];
  at: IsoValue;
  status: string;
}

const ASSET_COLUMNS = 'id, tenant_id, org_node_id, code, kind, serial, status, current_site_id';
const READING_COLUMNS = 'id, tenant_id, asset_id, kind, value, at, source';
const ITEM_COLUMNS = 'id, tenant_id, sku, name, unit, min_stock, active';
const MOVE_COLUMNS = 'id, tenant_id, item_id, warehouse_node_id, site_id, qty, kind, at, status';
const BUDGET_LINE_COLUMNS = 'id, tenant_id, site_id, item_id, description, qty_planned, unit_cost, active';
const PROGRESS_COLUMNS = 'id, tenant_id, site_id, budget_line_id, qty_done, at, reported_by, status';
const MILESTONE_COLUMNS = 'id, tenant_id, site_id, name, due_at, status';
const SITE_LOG_COLUMNS = 'id, tenant_id, site_id, author_id, text, attachment_ids, at, status';
const SITE_COLUMNS =
  'id, tenant_id, org_node_id, code, name, client_name, budget_total, started_at, ended_at, status';

function mapAsset(row: Record<string, unknown>): AssetRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    code: readString(row.code) ?? '',
    kind: readString(row.kind) ?? '',
    serial: readString(row.serial) ?? '',
    status: readString(row.status) ?? '',
    currentSiteId: readString(row.current_site_id) ?? null,
  };
}

function mapReading(row: Record<string, unknown>): AssetReadingRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    assetId: readString(row.asset_id) ?? '',
    kind: readString(row.kind) ?? '',
    value: readNumber(row.value),
    at: toIso(row.at),
    source: readString(row.source) ?? '',
  };
}

function mapItem(row: Record<string, unknown>): InventoryItemRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    sku: readString(row.sku) ?? '',
    name: readString(row.name) ?? '',
    unit: readString(row.unit) ?? '',
    minStock: readNumber(row.min_stock),
    active: readBoolean(row.active),
  };
}

function mapMove(row: Record<string, unknown>): StockMoveRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    itemId: readString(row.item_id) ?? '',
    warehouseNodeId: readString(row.warehouse_node_id) ?? '',
    siteId: readString(row.site_id) ?? null,
    qty: readNumber(row.qty),
    kind: readString(row.kind) ?? '',
    at: toIso(row.at),
    status: readString(row.status) ?? '',
  };
}

function mapBudgetLine(row: Record<string, unknown>): BudgetLineRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    siteId: readString(row.site_id) ?? '',
    itemId: readString(row.item_id) ?? null,
    description: readString(row.description) ?? '',
    qtyPlanned: readNumber(row.qty_planned),
    unitCost: readNumber(row.unit_cost),
    active: readBoolean(row.active),
  };
}

function mapProgress(row: Record<string, unknown>): ProgressEntryRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    siteId: readString(row.site_id) ?? '',
    budgetLineId: readString(row.budget_line_id) ?? null,
    qtyDone: readNumber(row.qty_done),
    at: toIso(row.at),
    reportedBy: readString(row.reported_by) ?? '',
    status: readString(row.status) ?? '',
  };
}

function mapMilestone(row: Record<string, unknown>): MilestoneRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    siteId: readString(row.site_id) ?? '',
    name: readString(row.name) ?? '',
    dueAt: toIso(row.due_at),
    status: readString(row.status) ?? '',
  };
}

function mapSiteLog(row: Record<string, unknown>): SiteLogRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    siteId: readString(row.site_id) ?? '',
    authorId: readString(row.author_id) ?? '',
    text: readString(row.text) ?? '',
    attachmentIds: readStringArray(row.attachment_ids),
    at: toIso(row.at),
    status: readString(row.status) ?? '',
  };
}

function mapSite(row: Record<string, unknown>): SiteRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    code: readString(row.code) ?? '',
    name: readString(row.name) ?? '',
    clientName: readString(row.client_name) ?? '',
    budgetTotal: readNumber(row.budget_total),
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    status: readString(row.status) ?? '',
  };
}

// ============ shared SQL ============

const SELECT_SITE_SQL = `SELECT ${SITE_COLUMNS}
FROM sites WHERE tenant_id = $1 AND id = $2`;
const SELECT_ASSET_SQL = `SELECT ${ASSET_COLUMNS}
FROM assets WHERE tenant_id = $1 AND id = $2`;
const INSERT_ASSET_SQL = `INSERT INTO assets
  (tenant_id, org_node_id, code, kind, serial, status, current_site_id)
VALUES ($1, $2, $3, $4, $5, 'available', NULL)
RETURNING ${ASSET_COLUMNS}`;
const ASSIGN_ASSET_SQL = `UPDATE assets
SET status = 'assigned', current_site_id = $3
WHERE tenant_id = $1 AND id = $2 AND status = 'available'
RETURNING ${ASSET_COLUMNS}`;
const SERVICE_ASSET_SQL = `UPDATE assets
SET status = 'maintenance', current_site_id = NULL
WHERE tenant_id = $1 AND id = $2 AND status <> 'retired'
RETURNING ${ASSET_COLUMNS}`;
const RETIRE_ASSET_SQL = `UPDATE assets
SET status = 'retired', current_site_id = NULL
WHERE tenant_id = $1 AND id = $2 AND status <> 'retired'
RETURNING ${ASSET_COLUMNS}`;
const INSERT_READING_SQL = `INSERT INTO asset_readings
  (tenant_id, asset_id, kind, value, source)
VALUES ($1, $2, $3, $4, $5)
RETURNING ${READING_COLUMNS}`;

const SELECT_ITEM_SQL = `SELECT ${ITEM_COLUMNS}
FROM inventory_items WHERE tenant_id = $1 AND id = $2`;
const INSERT_ITEM_SQL = `INSERT INTO inventory_items
  (tenant_id, sku, name, unit, min_stock, active)
VALUES ($1, $2, $3, $4, $5, TRUE)
RETURNING ${ITEM_COLUMNS}`;
const SELECT_MOVE_SQL = `SELECT ${MOVE_COLUMNS}
FROM stock_moves WHERE tenant_id = $1 AND id = $2`;
const AVAILABLE_STOCK_SQL = `SELECT COALESCE(SUM(CASE WHEN kind = 'in' THEN qty ELSE -qty END), 0) AS available
FROM stock_moves
WHERE tenant_id = $1 AND item_id = $2 AND warehouse_node_id = $3 AND status = 'posted'`;
const INSERT_MOVE_SQL = `INSERT INTO stock_moves
  (tenant_id, item_id, warehouse_node_id, site_id, qty, kind, status)
VALUES ($1, $2, $3, $4, $5, $6, 'posted')
RETURNING ${MOVE_COLUMNS}`;
const REVERSE_MOVE_SQL = `UPDATE stock_moves
SET status = 'reversed'
WHERE tenant_id = $1 AND id = $2 AND status = 'posted'
RETURNING ${MOVE_COLUMNS}`;

const SELECT_BUDGET_LINE_SQL = `SELECT ${BUDGET_LINE_COLUMNS}
FROM budget_lines WHERE tenant_id = $1 AND id = $2`;
const INSERT_BUDGET_LINE_SQL = `INSERT INTO budget_lines
  (tenant_id, site_id, item_id, description, qty_planned, unit_cost, active)
VALUES ($1, $2, $3, $4, $5, $6, TRUE)
RETURNING ${BUDGET_LINE_COLUMNS}`;
const INSERT_PROGRESS_SQL = `INSERT INTO progress_entries
  (tenant_id, site_id, budget_line_id, qty_done, reported_by, status)
VALUES ($1, $2, $3, $4, $5, 'posted')
RETURNING ${PROGRESS_COLUMNS}`;
const LIST_PROGRESS_SQL = `SELECT ${PROGRESS_COLUMNS}
FROM progress_entries WHERE tenant_id = $1 AND site_id = $2
ORDER BY at DESC LIMIT ${OBRA_LIST_LIMIT}`;
const INSERT_MILESTONE_SQL = `INSERT INTO milestones
  (tenant_id, site_id, name, due_at, status)
VALUES ($1, $2, $3, $4::timestamptz, CASE WHEN $4::timestamptz < now() THEN 'late' ELSE 'pending' END)
RETURNING ${MILESTONE_COLUMNS}`;

const SELECT_SITE_LOG_SQL = `SELECT ${SITE_LOG_COLUMNS}
FROM site_logs WHERE tenant_id = $1 AND id = $2`;
const INSERT_SITE_LOG_SQL = `INSERT INTO site_logs
  (tenant_id, site_id, author_id, text, attachment_ids, status)
VALUES ($1, $2, $3, $4, $5::uuid[], 'draft')
RETURNING ${SITE_LOG_COLUMNS}`;
const PUBLISH_SITE_LOG_SQL = `UPDATE site_logs
SET status = 'published'
WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
RETURNING ${SITE_LOG_COLUMNS}`;
const LIST_SITE_LOGS_SQL = `SELECT ${SITE_LOG_COLUMNS}
FROM site_logs WHERE tenant_id = $1 AND site_id = $2
ORDER BY at DESC LIMIT ${OBRA_LIST_LIMIT}`;

// ============ lookups + guard entrypoints ============

async function findSite(actor: ObraActorContext, siteId: string): Promise<SiteRecord | null> {
  const id = requireUuidParam(siteId, 'site id', actor.traceId);
  const result = await actor.client.query(SELECT_SITE_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapSite(row);
}

async function findAsset(actor: ObraActorContext, assetId: string): Promise<AssetRecord | null> {
  const id = requireUuidParam(assetId, 'asset id', actor.traceId);
  const result = await actor.client.query(SELECT_ASSET_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapAsset(row);
}

async function findMove(actor: ObraActorContext, moveId: string): Promise<StockMoveRecord | null> {
  const id = requireUuidParam(moveId, 'stock move id', actor.traceId);
  const result = await actor.client.query(SELECT_MOVE_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapMove(row);
}

async function findBudgetLine(
  actor: ObraActorContext,
  budgetLineId: string,
): Promise<BudgetLineRecord | null> {
  const result = await actor.client.query(SELECT_BUDGET_LINE_SQL, [actor.tenantId, budgetLineId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapBudgetLine(row);
}

async function findSiteLog(actor: ObraActorContext, logId: string): Promise<SiteLogRecord | null> {
  const id = requireUuidParam(logId, 'site log id', actor.traceId);
  const result = await actor.client.query(SELECT_SITE_LOG_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapSiteLog(row);
}

interface SiteGuard {
  readonly site: SiteRecord;
  readonly membership: MembershipRecord;
}

interface SiteActionOptions {
  readonly entity: string;
  readonly attemptedAction: string;
  readonly entityId?: string | null;
}

/**
 * Guards one site-scoped operation: central rule with `action` at the site's
 * org node, then the construction key (an active assignment, or a manager
 * whose subtree covers the site). A missing assignment is audited as
 * `access.denied` and refused with `obra.scope_denied`.
 */
async function requireSiteAction(
  actor: ObraActorContext,
  siteId: string,
  action: ActionCode,
  options: SiteActionOptions,
): Promise<SiteGuard> {
  const site = await findSite(actor, siteId);
  if (site === null) throw notFound('site', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action,
    entity: options.entity,
    entityId: options.entityId ?? site.id,
    orgNodeId: site.orgNodeId,
    attemptedAction: options.attemptedAction,
  });
  const assignment = await activeAssignment(actor, actor.userId, site.id);
  if (assignment !== null || ORG_SCOPED_SITE_ROLES.includes(membership.role)) {
    return { site, membership };
  }
  return deny(actor, scopeDenied('no_active_assignment', actor.traceId), {
    reason: 'obra.scope_denied',
    entity: options.entity,
    entityId: options.entityId ?? site.id,
    orgNodeId: site.orgNodeId,
    attemptedAction: options.attemptedAction,
  });
}

interface OrgActionOptions {
  readonly entity: string;
  readonly attemptedAction: string;
  readonly entityId?: string | null;
}

/** Guards one company/warehouse-scoped operation with the central rule only. */
async function requireOrgAction(
  actor: ObraActorContext,
  orgNodeId: string,
  action: ActionCode,
  options: OrgActionOptions,
): Promise<MembershipRecord> {
  const facts = await loadFacts(actor);
  return authorize(actor, facts, {
    action,
    entity: options.entity,
    entityId: options.entityId ?? null,
    orgNodeId,
    attemptedAction: options.attemptedAction,
  });
}

/** Rolls back the shared assignment key through `activeAssignment`. */
async function hasSiteAssignment(
  actor: ObraActorContext,
  siteId: string | null,
): Promise<boolean> {
  if (siteId === null) return false;
  return (await activeAssignment(actor, actor.userId, siteId)) !== null;
}

// ============ assets ============

interface AssetCreateInput {
  readonly orgNodeId: string;
  readonly code: string;
  readonly kind: string;
  readonly serial: string;
}

function parseAssetCreate(body: unknown, traceId: string): AssetCreateInput {
  const record = asRecord(body);
  return {
    orgNodeId: requireUuid(record, 'orgNodeId', traceId),
    code: requireString(record, 'code', traceId),
    kind: requireString(record, 'kind', traceId),
    serial: requireString(record, 'serial', traceId),
  };
}

/** Registers an equipment unit in `available` state (`site.write`). */
export async function registerAsset(
  actor: ObraActorContext,
  body: unknown,
): Promise<AssetRecord> {
  const input = parseAssetCreate(body, actor.traceId);
  const membership = await requireOrgAction(actor, input.orgNodeId, 'site.write', {
    entity: 'asset',
    attemptedAction: 'asset.create',
  });
  const rows = await insertResource(actor, `Asset code already exists: ${input.code}`, () =>
    actor.client.query(INSERT_ASSET_SQL, [
      actor.tenantId,
      input.orgNodeId,
      input.code,
      input.kind,
      input.serial,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Asset insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const asset = mapAsset(row);
  await writeAudit(actor, membership, {
    action: 'asset.created',
    entity: 'asset',
    entityId: asset.id,
    orgNodeId: asset.orgNodeId,
    diff: { code: asset.code, kind: asset.kind, status: asset.status },
  });
  return asset;
}

/**
 * Assigns an `available` asset to a site (`assignment.write`): the transition
 * sets `assigned` and the current site. Any other starting state answers
 * `obra.asset_unavailable`.
 */
export async function assignAsset(
  actor: ObraActorContext,
  assetId: string,
  body: unknown,
): Promise<AssetRecord> {
  const siteId = requireUuid(asRecord(body), 'siteId', actor.traceId);
  const { site, membership } = await requireSiteAction(actor, siteId, 'assignment.write', {
    entity: 'asset',
    entityId: assetId,
    attemptedAction: 'asset.assign',
  });
  const asset = await findAsset(actor, assetId);
  if (asset === null) throw notFound('asset', actor.traceId);
  if (asset.status !== 'available') {
    throw assetUnavailable(`asset.${asset.status}`, actor.traceId);
  }
  const result = await actor.client.query(ASSIGN_ASSET_SQL, [actor.tenantId, asset.id, site.id]);
  const row = readRows(result)[0];
  if (row === undefined) throw assetUnavailable('asset.not_available', actor.traceId);
  const assigned = mapAsset(row);
  await writeAudit(actor, membership, {
    action: 'asset.assigned',
    entity: 'asset',
    entityId: assigned.id,
    orgNodeId: assigned.orgNodeId,
    diff: { siteId: site.id, from: 'available', to: 'assigned' },
  });
  return assigned;
}

/** Sends an asset to `maintenance` and detaches it from its site (`site.write`). */
export async function setMaintenance(
  actor: ObraActorContext,
  assetId: string,
): Promise<AssetRecord> {
  const asset = await findAsset(actor, assetId);
  if (asset === null) throw notFound('asset', actor.traceId);
  const membership = await requireOrgAction(actor, asset.orgNodeId, 'site.write', {
    entity: 'asset',
    entityId: asset.id,
    attemptedAction: 'asset.maintenance',
  });
  if (asset.status === 'retired') throw assetUnavailable('asset.retired', actor.traceId);
  const result = await actor.client.query(SERVICE_ASSET_SQL, [actor.tenantId, asset.id]);
  const row = readRows(result)[0];
  if (row === undefined) throw assetUnavailable('asset.not_available', actor.traceId);
  const updated = mapAsset(row);
  await writeAudit(actor, membership, {
    action: 'asset.maintenance',
    entity: 'asset',
    entityId: updated.id,
    orgNodeId: updated.orgNodeId,
    diff: { from: asset.status, to: 'maintenance' },
  });
  return updated;
}

/** Retires an asset; a retired unit is not assignable again (`site.write`). */
export async function retireAsset(
  actor: ObraActorContext,
  assetId: string,
): Promise<AssetRecord> {
  const asset = await findAsset(actor, assetId);
  if (asset === null) throw notFound('asset', actor.traceId);
  const membership = await requireOrgAction(actor, asset.orgNodeId, 'site.write', {
    entity: 'asset',
    entityId: asset.id,
    attemptedAction: 'asset.retire',
  });
  if (asset.status === 'retired') throw assetUnavailable('asset.retired', actor.traceId);
  const result = await actor.client.query(RETIRE_ASSET_SQL, [actor.tenantId, asset.id]);
  const row = readRows(result)[0];
  if (row === undefined) throw assetUnavailable('asset.not_available', actor.traceId);
  const retired = mapAsset(row);
  await writeAudit(actor, membership, {
    action: 'asset.retired',
    entity: 'asset',
    entityId: retired.id,
    orgNodeId: retired.orgNodeId,
    diff: { from: asset.status, to: 'retired' },
  });
  return retired;
}

interface ReadingInput {
  readonly kind: string;
  readonly value: number;
  readonly source: string;
}

function parseReading(body: unknown, traceId: string): ReadingInput {
  const record = asRecord(body);
  const source =
    record.source === undefined || record.source === null
      ? 'manual'
      : requireString(record, 'source', traceId);
  return {
    kind: requireString(record, 'kind', traceId),
    value: requireNumber(record, 'value', traceId, { min: 0 }),
    source,
  };
}

/**
 * Appends one manual reading to `asset_readings` (insert-only, §2.4). A
 * caller that is not a manager needs an active assignment to the asset's
 * current site; a retired asset is not readable.
 */
export async function recordReading(
  actor: ObraActorContext,
  assetId: string,
  body: unknown,
): Promise<AssetReadingRecord> {
  const input = parseReading(body, actor.traceId);
  const asset = await findAsset(actor, assetId);
  if (asset === null) throw notFound('asset', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'attendance.mark',
    entity: 'asset_reading',
    entityId: asset.id,
    orgNodeId: asset.orgNodeId,
    attemptedAction: 'asset.reading',
  });
  if (!ORG_SCOPED_SITE_ROLES.includes(membership.role)) {
    const allowed = await hasSiteAssignment(actor, asset.currentSiteId);
    if (!allowed) {
      return deny(actor, scopeDenied('no_active_assignment', actor.traceId), {
        reason: 'obra.scope_denied',
        entity: 'asset_reading',
        entityId: asset.id,
        orgNodeId: asset.orgNodeId,
        attemptedAction: 'asset.reading',
      });
    }
  }
  if (asset.status === 'retired') throw assetUnavailable('asset.retired', actor.traceId);
  const rows = await insertResource(actor, 'Asset reading already exists', () =>
    actor.client.query(INSERT_READING_SQL, [
      actor.tenantId,
      asset.id,
      input.kind,
      input.value,
      input.source,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Asset reading insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const reading = mapReading(row);
  await writeAudit(actor, membership, {
    action: 'asset_reading.recorded',
    entity: 'asset_reading',
    entityId: reading.id,
    orgNodeId: asset.orgNodeId,
    diff: { assetId: asset.id, kind: reading.kind, value: reading.value },
  });
  return reading;
}

// ============ warehouse stock ============

interface ItemCreateInput {
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly minStock: number;
}

function parseItemCreate(body: unknown, traceId: string): ItemCreateInput {
  const record = asRecord(body);
  return {
    sku: requireString(record, 'sku', traceId),
    name: requireString(record, 'name', traceId),
    unit: requireString(record, 'unit', traceId),
    minStock: optionalNumber(record, 'minStock', traceId, 0, { min: 0 }),
  };
}

/** Creates a warehouse item (`stock.consume`, company scope). */
export async function createItem(
  actor: ObraActorContext,
  body: unknown,
): Promise<InventoryItemRecord> {
  const input = parseItemCreate(body, actor.traceId);
  const facts = await loadFacts(actor);
  const orgNodeId = facts.membership?.orgNodeId ?? actor.tenantId;
  const membership = await authorize(actor, facts, {
    action: 'stock.consume',
    entity: 'inventory_item',
    orgNodeId,
    attemptedAction: 'item.create',
  });
  const rows = await insertResource(actor, `Item sku already exists: ${input.sku}`, () =>
    actor.client.query(INSERT_ITEM_SQL, [
      actor.tenantId,
      input.sku,
      input.name,
      input.unit,
      input.minStock,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Item insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const item = mapItem(row);
  await writeAudit(actor, membership, {
    action: 'inventory_item.created',
    entity: 'inventory_item',
    entityId: item.id,
    orgNodeId,
    diff: { sku: item.sku, unit: item.unit, minStock: item.minStock },
  });
  return item;
}

interface MoveInput {
  readonly itemId: string;
  readonly warehouseNodeId: string;
  readonly siteId: string | null;
  readonly qty: number;
  readonly kind: 'in' | 'out' | 'transfer';
}

const MOVE_KINDS: readonly string[] = ['in', 'out', 'transfer'];

function parseMove(body: unknown, traceId: string): MoveInput {
  const record = asRecord(body);
  const kind = requireString(record, 'kind', traceId);
  if (!MOVE_KINDS.includes(kind)) throw badRequest(`Invalid stock move kind: ${kind}`, traceId);
  return {
    itemId: requireUuid(record, 'itemId', traceId),
    warehouseNodeId: requireUuid(record, 'warehouseNodeId', traceId),
    siteId: optionalUuid(record, 'siteId', traceId),
    qty: requireNumber(record, 'qty', traceId, { min: 0, exclusiveMin: true }),
    kind: kind as MoveInput['kind'],
  };
}

/** Posted quantity available for one item at one warehouse node. */
async function availableStock(
  actor: ObraActorContext,
  itemId: string,
  warehouseNodeId: string,
): Promise<number> {
  const result = await actor.client.query(AVAILABLE_STOCK_SQL, [
    actor.tenantId,
    itemId,
    warehouseNodeId,
  ]);
  return readNumber(readRows(result)[0]?.available);
}

/**
 * Registers a warehouse move and posts it in one step (`stock.consume`):
 * `in` always posts; `out`/`transfer` must not exceed the item's posted stock
 * at the warehouse (else `obra.insufficient_stock`). The guard runs at the
 * warehouse org node, so `almacen` reaches its own warehouses without an
 * assignment.
 */
export async function postStockMove(
  actor: ObraActorContext,
  body: unknown,
): Promise<StockMoveRecord> {
  const input = parseMove(body, actor.traceId);
  const membership = await requireOrgAction(actor, input.warehouseNodeId, 'stock.consume', {
    entity: 'stock_move',
    attemptedAction: 'stock.move.post',
  });
  const itemResult = await actor.client.query(SELECT_ITEM_SQL, [actor.tenantId, input.itemId]);
  if (readRows(itemResult).length === 0) throw notFound('inventory item', actor.traceId);
  if (input.kind !== 'in') {
    const available = await availableStock(actor, input.itemId, input.warehouseNodeId);
    if (available < input.qty) {
      throw insufficientStock(
        `Insufficient stock for item: available ${available}, requested ${input.qty}`,
        actor.traceId,
      );
    }
  }
  const rows = await insertResource(actor, 'Stock move already exists', () =>
    actor.client.query(INSERT_MOVE_SQL, [
      actor.tenantId,
      input.itemId,
      input.warehouseNodeId,
      input.siteId,
      input.qty,
      input.kind,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Stock move insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const move = mapMove(row);
  await writeAudit(actor, membership, {
    action: 'stock_move.posted',
    entity: 'stock_move',
    entityId: move.id,
    orgNodeId: input.warehouseNodeId,
    diff: { itemId: move.itemId, kind: move.kind, qty: move.qty, siteId: move.siteId },
  });
  return move;
}

/**
 * Reverses a `posted` move (`stock.consume`), writing the audit row and never
 * deleting the original. A reversal that would drive the warehouse stock below
 * zero is refused with `obra.insufficient_stock`.
 */
export async function reverseMove(
  actor: ObraActorContext,
  moveId: string,
): Promise<StockMoveRecord> {
  const move = await findMove(actor, moveId);
  if (move === null) throw notFound('stock move', actor.traceId);
  const membership = await requireOrgAction(actor, move.warehouseNodeId, 'stock.consume', {
    entity: 'stock_move',
    entityId: move.id,
    attemptedAction: 'stock.move.reverse',
  });
  if (move.status !== 'posted') {
    throw stateDenied(`stock_move.${move.status}`, actor.traceId);
  }
  if (move.kind === 'in') {
    const available = await availableStock(actor, move.itemId, move.warehouseNodeId);
    if (available - move.qty < 0) {
      throw insufficientStock(
        `Reversal would leave negative stock: available ${available}, reversed ${move.qty}`,
        actor.traceId,
      );
    }
  }
  const result = await actor.client.query(REVERSE_MOVE_SQL, [actor.tenantId, move.id]);
  const row = readRows(result)[0];
  if (row === undefined) throw stateDenied('stock_move.not_posted', actor.traceId);
  const reversed = mapMove(row);
  await writeAudit(actor, membership, {
    action: 'stock_move.reversed',
    entity: 'stock_move',
    entityId: reversed.id,
    orgNodeId: move.warehouseNodeId,
    diff: { itemId: reversed.itemId, kind: reversed.kind, qty: reversed.qty, from: 'posted', to: 'reversed' },
  });
  return reversed;
}

// ============ budget, progress and milestones ============

interface BudgetLineInput {
  readonly siteId: string;
  readonly itemId: string | null;
  readonly description: string;
  readonly qtyPlanned: number;
  readonly unitCost: number;
}

function parseBudgetLine(body: unknown, traceId: string): BudgetLineInput {
  const record = asRecord(body);
  return {
    siteId: requireUuid(record, 'siteId', traceId),
    itemId: optionalUuid(record, 'itemId', traceId),
    description: requireString(record, 'description', traceId),
    qtyPlanned: optionalNumber(record, 'qtyPlanned', traceId, 0, { min: 0 }),
    unitCost: optionalNumber(record, 'unitCost', traceId, 0, { min: 0 }),
  };
}

/** Creates a budget line for a site (`site.write`, managed at company scope). */
export async function createBudgetLine(
  actor: ObraActorContext,
  body: unknown,
): Promise<BudgetLineRecord> {
  const input = parseBudgetLine(body, actor.traceId);
  const { site, membership } = await requireSiteAction(actor, input.siteId, 'site.write', {
    entity: 'budget_line',
    attemptedAction: 'budget_line.create',
  });
  const rows = await insertResource(actor, 'Budget line already exists', () =>
    actor.client.query(INSERT_BUDGET_LINE_SQL, [
      actor.tenantId,
      input.siteId,
      input.itemId,
      input.description,
      input.qtyPlanned,
      input.unitCost,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Budget line insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const line = mapBudgetLine(row);
  await writeAudit(actor, membership, {
    action: 'budget_line.created',
    entity: 'budget_line',
    entityId: line.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: line.siteId, description: line.description, qtyPlanned: line.qtyPlanned },
  });
  return line;
}

interface ProgressInput {
  readonly siteId: string;
  readonly budgetLineId: string | null;
  readonly qtyDone: number;
}

function parseProgress(body: unknown, traceId: string): ProgressInput {
  const record = asRecord(body);
  return {
    siteId: requireUuid(record, 'siteId', traceId),
    budgetLineId: optionalUuid(record, 'budgetLineId', traceId),
    qtyDone: requireNumber(record, 'qtyDone', traceId, { min: 0 }),
  };
}

/**
 * Posts a progress entry (`attendance.mark` as the on-site field write). A
 * caller that is not a manager needs an active assignment to the site; the
 * optional budget line must belong to the same site.
 */
export async function postProgress(
  actor: ObraActorContext,
  body: unknown,
): Promise<ProgressEntryRecord> {
  const input = parseProgress(body, actor.traceId);
  const { site, membership } = await requireSiteAction(actor, input.siteId, 'attendance.mark', {
    entity: 'progress_entry',
    attemptedAction: 'progress.post',
  });
  if (input.budgetLineId !== null) {
    const line = await findBudgetLine(actor, input.budgetLineId);
    if (line === null) throw notFound('budget line', actor.traceId);
    if (line.siteId !== site.id) throw badRequest('Budget line belongs to another site', actor.traceId);
  }
  const rows = await insertResource(actor, 'Progress entry already exists', () =>
    actor.client.query(INSERT_PROGRESS_SQL, [
      actor.tenantId,
      site.id,
      input.budgetLineId,
      input.qtyDone,
      actor.userId,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Progress insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const entry = mapProgress(row);
  await writeAudit(actor, membership, {
    action: 'progress_entry.posted',
    entity: 'progress_entry',
    entityId: entry.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: entry.siteId, budgetLineId: entry.budgetLineId, qtyDone: entry.qtyDone },
  });
  return entry;
}

/** Lists the posted progress entries of a site (`site.read`). */
export async function listProgressEntries(
  actor: ObraActorContext,
  siteId: string,
): Promise<ProgressEntryRecord[]> {
  const { site } = await requireSiteAction(actor, siteId, 'site.read', {
    entity: 'progress_entry',
    attemptedAction: 'progress.list',
  });
  const result = await actor.client.query(LIST_PROGRESS_SQL, [actor.tenantId, site.id]);
  return readRows(result).map(mapProgress);
}

interface MilestoneInput {
  readonly siteId: string;
  readonly name: string;
  readonly dueAt: string;
}

function parseMilestone(body: unknown, traceId: string): MilestoneInput {
  const record = asRecord(body);
  const dueAt = requireString(record, 'dueAt', traceId);
  if (Number.isNaN(Date.parse(dueAt))) throw badRequest('dueAt must be an ISO timestamp', traceId);
  return {
    siteId: requireUuid(record, 'siteId', traceId),
    name: requireString(record, 'name', traceId),
    dueAt,
  };
}

/**
 * Sets a milestone (`site.write`). The status is decided by Postgres' clock:
 * a due date already in the past is stored as `late`, otherwise `pending`.
 */
export async function setMilestone(
  actor: ObraActorContext,
  body: unknown,
): Promise<MilestoneRecord> {
  const input = parseMilestone(body, actor.traceId);
  const { site, membership } = await requireSiteAction(actor, input.siteId, 'site.write', {
    entity: 'milestone',
    attemptedAction: 'milestone.set',
  });
  const rows = await insertResource(actor, 'Milestone already exists', () =>
    actor.client.query(INSERT_MILESTONE_SQL, [
      actor.tenantId,
      site.id,
      input.name,
      input.dueAt,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Milestone insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const milestone = mapMilestone(row);
  await writeAudit(actor, membership, {
    action: 'milestone.set',
    entity: 'milestone',
    entityId: milestone.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: milestone.siteId, name: milestone.name, status: milestone.status },
  });
  return milestone;
}

// ============ site log ============

interface SiteLogInput {
  readonly text: string;
  readonly attachmentIds: string[];
}

function parseSiteLog(body: unknown, traceId: string): SiteLogInput {
  const record = asRecord(body);
  const raw = record.attachmentIds;
  const attachmentIds: string[] = [];
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) throw badRequest('attachmentIds must be an array', traceId);
    for (const value of raw) {
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw badRequest('attachmentIds must contain UUIDs', traceId);
      }
      attachmentIds.push(value);
    }
  }
  return { text: requireString(record, 'text', traceId), attachmentIds };
}

/** Appends a `draft` site log (`attendance.mark`, on-site field write). */
export async function createSiteLog(
  actor: ObraActorContext,
  siteId: string,
  body: unknown,
): Promise<SiteLogRecord> {
  const input = parseSiteLog(body, actor.traceId);
  const { site, membership } = await requireSiteAction(actor, siteId, 'attendance.mark', {
    entity: 'site_log',
    attemptedAction: 'site_log.create',
  });
  const rows = await insertResource(actor, 'Site log already exists', () =>
    actor.client.query(INSERT_SITE_LOG_SQL, [
      actor.tenantId,
      site.id,
      actor.userId,
      input.text,
      input.attachmentIds,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Site log insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const log = mapSiteLog(row);
  await writeAudit(actor, membership, {
    action: 'site_log.created',
    entity: 'site_log',
    entityId: log.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: log.siteId, status: log.status },
  });
  return log;
}

/** Publishes a `draft` site log (`attendance.mark`); other states are `obra.state_denied`. */
export async function publishSiteLog(
  actor: ObraActorContext,
  siteId: string,
  logId: string,
): Promise<SiteLogRecord> {
  const { site, membership } = await requireSiteAction(actor, siteId, 'attendance.mark', {
    entity: 'site_log',
    entityId: logId,
    attemptedAction: 'site_log.publish',
  });
  const log = await findSiteLog(actor, logId);
  if (log === null) throw notFound('site log', actor.traceId);
  if (log.siteId !== site.id) throw notFound('site log', actor.traceId);
  if (log.status !== 'draft') throw stateDenied(`site_log.${log.status}`, actor.traceId);
  const result = await actor.client.query(PUBLISH_SITE_LOG_SQL, [actor.tenantId, log.id]);
  const row = readRows(result)[0];
  if (row === undefined) throw stateDenied('site_log.not_draft', actor.traceId);
  const published = mapSiteLog(row);
  await writeAudit(actor, membership, {
    action: 'site_log.published',
    entity: 'site_log',
    entityId: published.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: published.siteId, from: 'draft', to: 'published' },
  });
  return published;
}

/** Lists the site logs of a site (`site.read`). */
export async function listSiteLogs(
  actor: ObraActorContext,
  siteId: string,
): Promise<SiteLogRecord[]> {
  const { site } = await requireSiteAction(actor, siteId, 'site.read', {
    entity: 'site_log',
    attemptedAction: 'site_log.list',
  });
  const result = await actor.client.query(LIST_SITE_LOGS_SQL, [actor.tenantId, site.id]);
  return readRows(result).map(mapSiteLog);
}
