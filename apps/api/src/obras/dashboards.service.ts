// Obras dashboards — site board and company board (bases-consolidadas-v1.md
// §2.4, §3.1, §3.4, §6.2).
//
// Deliberately plain, like `obras.service.ts` and `resources.service.ts`: no
// decorators, because `npm test` loads the sources through Node's strip-only
// TypeScript (which rejects decorator syntax). The HTTP skin lives in
// `dashboards.controller.ts` and stays thin; this module owns the use case:
//   1. validate the site id and the requested day;
//   2. for the site board, resolve access through `requireSiteAccess`, which
//      runs the central rule plus the construction key (active assignment, or a
//      manager whose membership subtree covers the site) and audits a denial;
//      for the company board, run the central rule with `site.read` at the
//      membership org node so every site the caller can see bounds the KPIs;
//   3. run bounded tenant-scoped SQL for the board KPIs.
//
// §6.2 KPI contract:
//   * site board — avance por partida (`qty_done` vs `qty_planned`), asistencia
//     del día (counts per `attendance.status`), stock crítico (`inventory_items`
//     under `min_stock`), equipos en mantenimiento and hitos próximos.
//   * company board — avance global over the caller scope.
//
// Explicitly out of scope, documented rather than faked: **cobranza** does not
// apply to the construction vertical (MVP1 Obras has no invoicing/payment table
// in scope — that is the billing vertical) and **uso por módulo** is not
// available because MVP1 records no per-module usage metric. Both are surfaced
// as `notApplicable` notes so an API consumer cannot mistake an absent number
// for a zero.
//
// Read-path note (load-bearing, §6.2): the consolidated bases specify that the
// dashboards read the read replica with a short Redis cache and never the
// primary. MVP1 has neither: these are direct bounded queries against the
// request transaction's connection. Pointing the connection at the replica and
// adding the cache is the follow-up; the KPI contract and the HTTP surface do
// not change. Every row-returning query carries a `LIMIT` and every aggregate
// collapses to one row (`LIMIT 1`).
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction } from '../auth/policy.ts';
import {
  OBRA_MODULE,
  requireSiteAccess,
  type ObraActorContext,
  type ObraClient,
  type SiteRecord,
} from './obras.service.ts';

export type { ObraActorContext, ObraClient };

/** Rows a row-returning board query may yield; keeps a stray wide scan bounded. */
export const BOARD_LIST_LIMIT = 200;

/** Upcoming milestones the site board shows at most. */
export const UPCOMING_MILESTONE_LIMIT = 20;

/** Horizon of «hitos próximos»: overdue plus the next 30 days. */
export const UPCOMING_MILESTONE_HORIZON_DAYS = 30;

// ============ error envelope ============

/** 403 envelope carrying the guard reason for observability. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 400 envelope for a body/param that fails validation. */
function badRequest(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'validation.failed', message, traceId }, 400);
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

/** `pg` returns INT/BIGINT/NUMERIC aggregates as string; normalize. */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** One decimal is enough for a completion ratio. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `done / planned` as a percentage; a zero plan reports 0, not NaN/Infinity. */
function percentOf(done: number, planned: number): number {
  if (planned <= 0) return 0;
  return round1((done / planned) * 100);
}

/** Strict calendar check: `YYYY-MM-DD` and a date the calendar actually has. */
function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Today in UTC. The SQL filter is the authority; this value is the label the
 * board echoes back, so a caller that omits `?date=` still sees which day it
 * read. The replica/cache layer will own the tenant timezone.
 */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(raw: string | undefined, traceId: string): string {
  const value = raw?.trim() ?? '';
  if (value === '') return todayIsoDate();
  if (!isCalendarDate(value)) {
    throw badRequest('date must be a real YYYY-MM-DD date', traceId);
  }
  return value;
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
  readonly entity: string;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly attemptedAction: string;
}

/** Runs the central rule for one board and audits any denial before 403. */
async function authorize(
  actor: ObraActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions,
): Promise<MembershipRecord> {
  const rolePermits = facts.membership !== null && rolePermitsAction(facts.membership.role, 'site.read');
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: actor.roles, scope: [] },
    membership: facts.membership,
    entityOrgNodeId: options.orgNodeId,
    scopeSubtree: [...facts.scopeSubtree],
    rolePermits,
    stateAllows: true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: options.entity,
      entityId: options.entityId ?? null,
      orgNodeId: options.orgNodeId,
      attemptedAction: options.attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ board shapes ============

/** Avance of one budget line: `qty_done` over the posted progress entries. */
export interface ProgressLineBoard {
  readonly budgetLineId: string;
  readonly description: string;
  readonly qtyPlanned: number;
  readonly qtyDone: number;
  /** Never negative: an over-delivered line reports 0 remaining, not a debt. */
  readonly qtyRemaining: number;
  readonly percent: number;
}

/** Attendance of one day, counted per `attendance.status`. */
export interface AttendanceDayBoard {
  readonly date: string;
  readonly registered: number;
  readonly approved: number;
  readonly rejected: number;
  readonly adjusted: number;
  readonly total: number;
}

/** One inventory item whose posted stock sits under its `min_stock`. */
export interface CriticalStockBoard {
  readonly itemId: string;
  readonly sku: string;
  readonly name: string;
  readonly unit: string;
  readonly minStock: number;
  readonly available: number;
}

/** One equipment unit currently in `maintenance`. */
export interface MaintenanceAssetBoard {
  readonly assetId: string;
  readonly code: string;
  readonly kind: string;
  readonly serial: string;
}

/** One milestone that is not done and is due within the horizon. */
export interface UpcomingMilestoneBoard {
  readonly milestoneId: string;
  readonly name: string;
  readonly dueAt: string | null;
  readonly status: string;
}

/** The site board (§6.2 «tablero de obra»). */
export interface SiteBoard {
  readonly siteId: string;
  readonly siteCode: string;
  readonly orgNodeId: string;
  readonly date: string;
  readonly progress: readonly ProgressLineBoard[];
  readonly attendance: AttendanceDayBoard;
  readonly criticalStock: readonly CriticalStockBoard[];
  readonly maintenanceAssets: readonly MaintenanceAssetBoard[];
  readonly upcomingMilestones: readonly UpcomingMilestoneBoard[];
}

/** Non-applicable KPIs, stated explicitly instead of reported as zero. */
export interface CompanyBoardNotApplicable {
  readonly collections: string;
  readonly moduleUsage: string;
}

/** The company board: global progress over the caller scope. */
export interface CompanyBoard {
  readonly orgNodeId: string;
  readonly date: string;
  readonly sites: {
    readonly total: number;
    readonly active: number;
    readonly planned: number;
    readonly closed: number;
  };
  readonly progress: {
    readonly qtyPlanned: number;
    readonly qtyDone: number;
    readonly qtyRemaining: number;
    readonly percent: number;
  };
  readonly notApplicable: CompanyBoardNotApplicable;
}

// ============ SQL ============

// Every query is bounded: row-returning statements carry a LIMIT and the KPI
// statements are aggregates (COUNT/SUM) that collapse to one row. The sede
// filter is the subtree of the requested org node, so a network board shows its
// sedes and a site board shows only itself.
const PROGRESS_BY_LINE_SQL = `SELECT b.id AS budget_line_id, b.description, b.qty_planned,
  COALESCE(SUM(p.qty_done), 0) AS qty_done
FROM budget_lines b
LEFT JOIN progress_entries p
  ON p.budget_line_id = b.id AND p.tenant_id = b.tenant_id AND p.status = 'posted'
WHERE b.tenant_id = $1 AND b.site_id = $2 AND b.active = TRUE
GROUP BY b.id, b.description, b.qty_planned
ORDER BY b.description
LIMIT ${BOARD_LIST_LIMIT}`;

const ATTENDANCE_STATUS_SQL = `SELECT status, COUNT(*) AS total
FROM attendance
WHERE tenant_id = $1 AND site_id = $2
  AND check_in >= $3::date
  AND check_in < ($3::date + INTERVAL '1 day')
GROUP BY status
LIMIT ${BOARD_LIST_LIMIT}`;

const CRITICAL_STOCK_SQL = `SELECT i.id AS item_id, i.sku, i.name, i.unit, i.min_stock,
  COALESCE(SUM(CASE WHEN m.kind = 'in' THEN m.qty ELSE -m.qty END), 0) AS available
FROM inventory_items i
LEFT JOIN stock_moves m
  ON m.item_id = i.id AND m.tenant_id = i.tenant_id
  AND m.status = 'posted' AND m.warehouse_node_id = ANY($2::uuid[])
WHERE i.tenant_id = $1 AND i.active = TRUE
GROUP BY i.id, i.sku, i.name, i.unit, i.min_stock
HAVING COALESCE(SUM(CASE WHEN m.kind = 'in' THEN m.qty ELSE -m.qty END), 0) < i.min_stock
ORDER BY i.sku
LIMIT ${BOARD_LIST_LIMIT}`;

const MAINTENANCE_ASSETS_SQL = `SELECT id, code, kind, serial
FROM assets
WHERE tenant_id = $1 AND org_node_id = ANY($2::uuid[]) AND status = 'maintenance'
ORDER BY code
LIMIT ${BOARD_LIST_LIMIT}`;

const UPCOMING_MILESTONES_SQL = `SELECT id, name, due_at, status
FROM milestones
WHERE tenant_id = $1 AND site_id = $2 AND status <> 'done'
  AND due_at < now() + INTERVAL '${UPCOMING_MILESTONE_HORIZON_DAYS} days'
ORDER BY due_at
LIMIT ${UPCOMING_MILESTONE_LIMIT}`;

const COMPANY_SITES_SQL = `SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'active') AS active,
  COUNT(*) FILTER (WHERE status = 'planned') AS planned,
  COUNT(*) FILTER (WHERE status = 'closed') AS closed
FROM sites
WHERE tenant_id = $1 AND org_node_id = ANY($2::uuid[])
LIMIT 1`;

const COMPANY_PLANNED_SQL = `SELECT COALESCE(SUM(b.qty_planned), 0) AS qty_planned
FROM budget_lines b
JOIN sites s ON s.id = b.site_id AND s.tenant_id = b.tenant_id
WHERE b.tenant_id = $1 AND s.org_node_id = ANY($2::uuid[]) AND b.active = TRUE
LIMIT 1`;

const COMPANY_PROGRESS_SQL = `SELECT COALESCE(SUM(p.qty_done), 0) AS qty_done
FROM progress_entries p
JOIN sites s ON s.id = p.site_id AND s.tenant_id = p.tenant_id
WHERE p.tenant_id = $1 AND s.org_node_id = ANY($2::uuid[]) AND p.status = 'posted'
LIMIT 1`;

// ============ use cases ============

function mapProgressLine(row: Record<string, unknown>): ProgressLineBoard {
  const qtyPlanned = toNumber(row.qty_planned);
  const qtyDone = toNumber(row.qty_done);
  return {
    budgetLineId: readString(row.budget_line_id) ?? '',
    description: readString(row.description) ?? '',
    qtyPlanned,
    qtyDone,
    qtyRemaining: Math.max(0, qtyPlanned - qtyDone),
    percent: percentOf(qtyDone, qtyPlanned),
  };
}

/** Folds the `status → count` rows into the fixed status counters. */
function mapAttendance(rows: readonly Record<string, unknown>[], date: string): AttendanceDayBoard {
  let registered = 0;
  let approved = 0;
  let rejected = 0;
  let adjusted = 0;
  for (const row of rows) {
    const total = toNumber(row.total);
    switch (readString(row.status)) {
      case 'registered':
        registered += total;
        break;
      case 'approved':
        approved += total;
        break;
      case 'rejected':
        rejected += total;
        break;
      case 'adjusted':
        adjusted += total;
        break;
      default:
        break;
    }
  }
  return { date, registered, approved, rejected, adjusted, total: registered + approved + rejected + adjusted };
}

/**
 * Returns the board of one site for one day. Access follows
 * `requireSiteAccess` (central rule plus the construction key), so an
 * assignment-scoped worker sees its own site and a manager sees the sites its
 * subtree covers.
 */
export async function getSiteBoard(
  actor: ObraActorContext,
  siteId: string,
  date?: string,
): Promise<SiteBoard> {
  if (!UUID_RE.test(siteId?.trim() ?? '')) throw badRequest('Invalid site id', actor.traceId);
  const boardDate = parseDate(date, actor.traceId);
  const site: SiteRecord = await requireSiteAccess(actor, actor.userId, siteId.trim());
  const scope = await loadScopeSubtree(actor.client, actor.tenantId, site.orgNodeId);

  const progress = await actor.client.query(PROGRESS_BY_LINE_SQL, [actor.tenantId, site.id]);
  const attendance = await actor.client.query(ATTENDANCE_STATUS_SQL, [
    actor.tenantId,
    site.id,
    boardDate,
  ]);
  const critical = await actor.client.query(CRITICAL_STOCK_SQL, [actor.tenantId, scope]);
  const maintenance = await actor.client.query(MAINTENANCE_ASSETS_SQL, [actor.tenantId, scope]);
  const milestones = await actor.client.query(UPCOMING_MILESTONES_SQL, [actor.tenantId, site.id]);

  return {
    siteId: site.id,
    siteCode: site.code,
    orgNodeId: site.orgNodeId,
    date: boardDate,
    progress: readRows(progress).map(mapProgressLine),
    attendance: mapAttendance(readRows(attendance), boardDate),
    criticalStock: readRows(critical).map((row) => ({
      itemId: readString(row.item_id) ?? '',
      sku: readString(row.sku) ?? '',
      name: readString(row.name) ?? '',
      unit: readString(row.unit) ?? '',
      minStock: toNumber(row.min_stock),
      available: toNumber(row.available),
    })),
    maintenanceAssets: readRows(maintenance).map((row) => ({
      assetId: readString(row.id) ?? '',
      code: readString(row.code) ?? '',
      kind: readString(row.kind) ?? '',
      serial: readString(row.serial) ?? '',
    })),
    upcomingMilestones: readRows(milestones).map((row) => ({
      milestoneId: readString(row.id) ?? '',
      name: readString(row.name) ?? '',
      dueAt: toIso(row.due_at),
      status: readString(row.status) ?? '',
    })),
  };
}

/**
 * Returns the company board over the caller's scope. The KPIs aggregate every
 * site inside the membership subtree; `notApplicable` records the two §6.2
 * blocks that do not exist in MVP1 (cobranza, uso por módulo).
 */
export async function getCompanyBoard(actor: ObraActorContext): Promise<CompanyBoard> {
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'dashboard',
    entityId: null,
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'board.company',
  });
  const scope = [...facts.scopeSubtree];

  const sites = await actor.client.query(COMPANY_SITES_SQL, [actor.tenantId, scope]);
  const planned = await actor.client.query(COMPANY_PLANNED_SQL, [actor.tenantId, scope]);
  const done = await actor.client.query(COMPANY_PROGRESS_SQL, [actor.tenantId, scope]);

  const sitesRow = readRows(sites)[0] ?? {};
  const qtyPlanned = toNumber(readRows(planned)[0]?.qty_planned);
  const qtyDone = toNumber(readRows(done)[0]?.qty_done);

  return {
    orgNodeId: membership.orgNodeId,
    date: todayIsoDate(),
    sites: {
      total: toNumber(sitesRow.total),
      active: toNumber(sitesRow.active),
      planned: toNumber(sitesRow.planned),
      closed: toNumber(sitesRow.closed),
    },
    progress: {
      qtyPlanned,
      qtyDone,
      qtyRemaining: Math.max(0, qtyPlanned - qtyDone),
      percent: percentOf(qtyDone, qtyPlanned),
    },
    notApplicable: {
      collections: 'not applicable: MVP1 Obras has no invoicing/collections (billing vertical)',
      moduleUsage: 'not applicable: MVP1 records no per-module usage metric',
    },
  };
}
