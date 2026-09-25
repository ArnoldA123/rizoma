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
// primary. R2 adds the Redis half: every board below reads through
// `cache/boards.ts` (cache-aside, obras TTL 300s, fail-open to the primary).
// There is still no replica — the cache sits in front of the same request
// transaction connection — and v1 does no write invalidation: a board is
// fresh for its `{day}` window plus its TTL at most, matching the web poll
// rhythm. Every row-returning query carries a `LIMIT` and every aggregate
// collapses to one row (`LIMIT 1`); only the connection target (replica) is
// still a follow-up. The KPI contract and the HTTP surface do not change.
import { HttpException } from '@nestjs/common';
import {
  OBRAS_BOARD_TTL_SECONDS,
  getBoard as getCachedBoard,
  obrasCompanyBoardKey,
  obrasCompanyComparedBoardKey,
  obrasSiteBoardKey,
  obrasSiteComparedBoardKey,
  setBoard as setCachedBoard,
  withBoardCache,
  type BoardCacheClient,
} from '../cache/boards.ts';
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

/** Days a `previous-week` comparison looks back: the board day vs −7d. */
export const BOARD_COMPARE_DAYS = 7;

/** `?compare=` modes. The previous-week snapshot is the only one in MVP1. */
export const BOARD_COMPARE_MODES = ['previous-week'] as const;
export type BoardCompareMode = (typeof BOARD_COMPARE_MODES)[number];

/** `.../export?format=` values. CSV is the only BI export in MVP1. */
export const BOARD_EXPORT_FORMATS = ['csv'] as const;
export type BoardExportFormat = (typeof BOARD_EXPORT_FORMATS)[number];

/** Content type of every board export. */
export const BOARD_EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8';

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

/** Two decimals keep quantity fractions in a delta; counts stay exact. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Moves a `YYYY-MM-DD` day by whole days, staying in UTC. */
function shiftIsoDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
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

function parseCompare(raw: string | undefined, traceId: string): BoardCompareMode {
  const value = raw?.trim() ?? '';
  if (value === '') return 'previous-week';
  if (!(BOARD_COMPARE_MODES as readonly string[]).includes(value)) {
    throw badRequest(`Unknown compare mode (expected ${BOARD_COMPARE_MODES.join('|')}): ${value}`, traceId);
  }
  return value as BoardCompareMode;
}

function parseExportFormat(raw: string | undefined, traceId: string): BoardExportFormat {
  const value = raw?.trim() ?? '';
  if (!(BOARD_EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw badRequest(
      `Unknown export format (expected ${BOARD_EXPORT_FORMATS.join('|')}): ${value === '' ? '(missing)' : value}`,
      traceId,
    );
  }
  return value as BoardExportFormat;
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

/**
 * Day-over-day comparison of one site board: the board of `date` next to the
 * board of `date − 7d`, plus the drift of the date-filtered KPI (attendance).
 *
 * Both legs run the same parametrized SQL; only the date changes. Progress,
 * critical stock, maintenance assets and upcoming milestones are scope-state
 * reads, identical in both legs by construction, so they carry no delta.
 */
export interface ComparedSiteBoard {
  readonly current: SiteBoard;
  readonly previous: SiteBoard;
  readonly delta: Record<string, number>;
}

/**
 * Comparison of the company board. The company KPIs are scope-state (sites in
 * the membership subtree and their cumulative progress), not day-state, so
 * both legs read the same snapshot and the drift is 0 by construction; the
 * value of the envelope is the labeled previous date for external BI series.
 */
export interface ComparedCompanyBoard {
  readonly current: CompanyBoard;
  readonly previous: CompanyBoard;
  readonly delta: Record<string, number>;
}

/** One BI export: a CSV of the board aggregate with its safe filename. */
export interface BoardExport {
  readonly filename: string;
  readonly contentType: string;
  readonly csv: string;
}

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
 * Reads one site board for one day. The caller must already hold site access;
 * this is the shared leg of `getSiteBoard`, `getComparedSiteBoard` and
 * `exportSiteBoard`.
 */
async function readSiteBoard(
  actor: ObraActorContext,
  site: SiteRecord,
  scope: readonly string[],
  boardDate: string,
): Promise<SiteBoard> {
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

/** Drift (`current − previous`) of the date-filtered site KPI: attendance. */
function diffSiteBoards(current: SiteBoard, previous: SiteBoard): Record<string, number> {
  return {
    attendanceRegistered: round2(current.attendance.registered - previous.attendance.registered),
    attendanceApproved: round2(current.attendance.approved - previous.attendance.approved),
    attendanceRejected: round2(current.attendance.rejected - previous.attendance.rejected),
    attendanceAdjusted: round2(current.attendance.adjusted - previous.attendance.adjusted),
    attendanceTotal: round2(current.attendance.total - previous.attendance.total),
  };
}

/** Drift (`current − previous`) of the company scope-state KPIs. */
function diffCompanyBoards(current: CompanyBoard, previous: CompanyBoard): Record<string, number> {
  return {
    sitesTotal: round2(current.sites.total - previous.sites.total),
    sitesActive: round2(current.sites.active - previous.sites.active),
    sitesPlanned: round2(current.sites.planned - previous.sites.planned),
    sitesClosed: round2(current.sites.closed - previous.sites.closed),
    qtyPlanned: round2(current.progress.qtyPlanned - previous.progress.qtyPlanned),
    qtyDone: round2(current.progress.qtyDone - previous.progress.qtyDone),
    qtyRemaining: round2(current.progress.qtyRemaining - previous.progress.qtyRemaining),
    percent: round2(current.progress.percent - previous.progress.percent),
  };
}

/**
 * Filename of a board export. The date comes from the calendar check, so it
 * can only carry safe characters; operator-controlled text (the site code) is
 * scrubbed to `[A-Za-z0-9._-]`, mirroring the strictness of the imports
 * errors-CSV naming: never a separator, a control character or a leading dot.
 */
function safeExportFilename(stem: string, fallback: string): string {
  const scrubbed = stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
  const candidate = scrubbed === '' ? fallback : `${scrubbed}.csv`;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(candidate) || candidate.startsWith('.')) {
    return fallback;
  }
  return candidate;
}

/** One CSV field: text, a number, or an empty cell. */
type CsvCell = string | number | null;

/** One CSV data row. */
type CsvRow = readonly CsvCell[];

/** One CSV cell: quoted only when it carries a comma, quote or line break. */
function csvCell(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header plus rows, one trailing newline, no BOM: the BI-friendly shape. */
function csvTable(header: readonly string[], rows: readonly CsvRow[]): string {
  const lines = [
    header.join(','),
    ...rows.map((row) => row.map((cell) => (cell === null ? '' : csvCell(cell))).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The site board as CSV: one row per budget line (the row-returning
 * aggregate, already `LIMIT`-bounded) with the day attendance as context
 * columns. A site with no budget lines still exports one row carrying the
 * attendance, so the file is never header-only.
 */
function siteBoardToCsv(board: SiteBoard): string {
  const header = ['site_id', 'site_code', 'org_node_id', 'date', 'budget_line_id', 'description', 'qty_planned', 'qty_done', 'qty_remaining', 'percent', 'attendance_registered', 'attendance_approved', 'attendance_rejected', 'attendance_adjusted', 'attendance_total'];
  const attendance: readonly number[] = [board.attendance.registered, board.attendance.approved, board.attendance.rejected, board.attendance.adjusted, board.attendance.total];
  const rows: CsvRow[] =
    board.progress.length === 0
      ? [[board.siteId, board.siteCode, board.orgNodeId, board.date, null, null, null, null, null, null, ...attendance]]
      : board.progress.map((line) => [board.siteId, board.siteCode, board.orgNodeId, board.date, line.budgetLineId, line.description, line.qtyPlanned, line.qtyDone, line.qtyRemaining, line.percent, ...attendance]);
  return csvTable(header, rows);
}

/** The company board as one CSV row (wide format, same numbers as the JSON). */
function companyBoardToCsv(board: CompanyBoard): string {
  return csvTable(
    ['org_node_id', 'date', 'sites_total', 'sites_active', 'sites_planned', 'sites_closed', 'qty_planned', 'qty_done', 'qty_remaining', 'percent'],
    [[board.orgNodeId, board.date, board.sites.total, board.sites.active, board.sites.planned, board.sites.closed, board.progress.qtyPlanned, board.progress.qtyDone, board.progress.qtyRemaining, board.progress.percent]],
  );
}
/**
 * Returns the board of one site for one day. Access follows
 * `requireSiteAccess` (central rule plus the construction key), so an
 * assignment-scoped worker sees its own site and a manager sees the sites its
 * subtree covers.
 *
 * Cache-aside (R2): with a `cache` (the shared `REDIS_CLIENT`), the bounded
 * primary SQL runs once per `{tenant, site, date}` per TTL (300s). Without
 * it — or with Redis down — the read falls through to the primary; the cache
 * never turns a board into a 500. Day-scoped writes do not invalidate in v1
 * (see `cache/boards.ts`).
 */
export async function getSiteBoard(
  actor: ObraActorContext,
  siteId: string,
  date?: string,
  cache?: BoardCacheClient | null,
): Promise<SiteBoard> {
  if (!UUID_RE.test(siteId?.trim() ?? '')) throw badRequest('Invalid site id', actor.traceId);
  const boardDate = parseDate(date, actor.traceId);
  const site: SiteRecord = await requireSiteAccess(actor, actor.userId, siteId.trim());
  const scope = await loadScopeSubtree(actor.client, actor.tenantId, site.orgNodeId);
  const key = obrasSiteBoardKey(actor.tenantId, site.id, boardDate);
  return withBoardCache(cache, key, OBRAS_BOARD_TTL_SECONDS, () =>
    readSiteBoard(actor, site, scope, boardDate),
  );
}

/**
 * Returns `{current, previous, delta}` for one site: the board of `date`
 * next to the board of `date − 7d`, with the same parametrized SQL on both
 * legs. Site access resolves once, so the comparison cannot widen what
 * `getSiteBoard` allows. The envelope is cached under its own `:prev7d` key
 * with the same TTL and fail-open rule as `getSiteBoard`.
 */
export async function getComparedSiteBoard(
  actor: ObraActorContext,
  siteId: string,
  date?: string,
  compare?: string,
  cache?: BoardCacheClient | null,
): Promise<ComparedSiteBoard> {
  parseCompare(compare, actor.traceId);
  if (!UUID_RE.test(siteId?.trim() ?? '')) throw badRequest('Invalid site id', actor.traceId);
  const boardDate = parseDate(date, actor.traceId);
  const site: SiteRecord = await requireSiteAccess(actor, actor.userId, siteId.trim());
  const scope = await loadScopeSubtree(actor.client, actor.tenantId, site.orgNodeId);
  const previousDate = shiftIsoDate(boardDate, -BOARD_COMPARE_DAYS);
  const key = obrasSiteComparedBoardKey(actor.tenantId, site.id, boardDate);
  return withBoardCache(cache, key, OBRAS_BOARD_TTL_SECONDS, async () => {
    const current = await readSiteBoard(actor, site, scope, boardDate);
    const previous = await readSiteBoard(actor, site, scope, previousDate);
    return { current, previous, delta: diffSiteBoards(current, previous) };
  });
}

/**
 * Exports one site board as CSV (`GET .../board/export?format=csv`). Same
 * aggregates and same `LIMIT` as the JSON board, progress-line grain with the
 * day attendance as context columns. The optional `cache` is forwarded to
 * `getSiteBoard`, so exports share the board keys instead of minting CSV ones.
 */
export async function exportSiteBoard(
  actor: ObraActorContext,
  siteId: string,
  date?: string,
  format?: string,
  cache?: BoardCacheClient | null,
): Promise<BoardExport> {
  parseExportFormat(format, actor.traceId);
  const board = await getSiteBoard(actor, siteId, date, cache);
  return {
    filename: safeExportFilename(`tablero-obra-${board.siteCode}-${board.date}`, 'tablero-obra.csv'),
    contentType: BOARD_EXPORT_CONTENT_TYPE,
    csv: siteBoardToCsv(board),
  };
}

/** Plain scope-state snapshot behind the company board: JSON-safe on purpose. */
interface CompanySnapshot {
  readonly total: number;
  readonly active: number;
  readonly plannedSites: number;
  readonly closed: number;
  readonly qtyPlanned: number;
  readonly qtyDone: number;
}

/**
 * Reads the company board over the caller's scope for one labeled day. The
 * KPIs are scope-state (they aggregate the membership subtree), so the day is
 * an echoed label for BI series, not a filter — the same rule the company
 * `date` already followed before it became a parameter.
 *
 * Only the three scope-state aggregates are cached (key
 * `rizoma:v1:{tenant}:obras:company:{org}:{date}`, TTL 300s); the guard facts
 * and authorization always run against the primary.
 */
async function readCompanyBoard(
  actor: ObraActorContext,
  boardDate: string,
  cache?: BoardCacheClient | null,
): Promise<CompanyBoard> {
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'dashboard',
    entityId: null,
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'board.company',
  });
  const scope = [...facts.scopeSubtree];

  const key = obrasCompanyBoardKey(actor.tenantId, membership.orgNodeId, boardDate);
  const snapshot = await withBoardCache<CompanySnapshot>(
    cache,
    key,
    OBRAS_BOARD_TTL_SECONDS,
    async () => {
      const sites = await actor.client.query(COMPANY_SITES_SQL, [actor.tenantId, scope]);
      const planned = await actor.client.query(COMPANY_PLANNED_SQL, [actor.tenantId, scope]);
      const done = await actor.client.query(COMPANY_PROGRESS_SQL, [actor.tenantId, scope]);
      const sitesRow = readRows(sites)[0] ?? {};
      return {
        total: toNumber(sitesRow.total),
        active: toNumber(sitesRow.active),
        plannedSites: toNumber(sitesRow.planned),
        closed: toNumber(sitesRow.closed),
        qtyPlanned: toNumber(readRows(planned)[0]?.qty_planned),
        qtyDone: toNumber(readRows(done)[0]?.qty_done),
      };
    },
  );

  return {
    orgNodeId: membership.orgNodeId,
    date: boardDate,
    sites: {
      total: snapshot.total,
      active: snapshot.active,
      planned: snapshot.plannedSites,
      closed: snapshot.closed,
    },
    progress: {
      qtyPlanned: snapshot.qtyPlanned,
      qtyDone: snapshot.qtyDone,
      qtyRemaining: Math.max(0, snapshot.qtyPlanned - snapshot.qtyDone),
      percent: percentOf(snapshot.qtyDone, snapshot.qtyPlanned),
    },
    notApplicable: {
      collections: 'not applicable: MVP1 Obras has no invoicing/collections (billing vertical)',
      moduleUsage: 'not applicable: MVP1 records no per-module usage metric',
    },
  };
}

/**
 * Returns the company board over the caller's scope. The KPIs aggregate every
 * site inside the membership subtree; `notApplicable` records the two §6.2
 * blocks that do not exist in MVP1 (cobranza, uso por módulo). The optional
 * `cache` warms the company key (TTL 300s) with the same fail-open rule as
 * the site board.
 */
export async function getCompanyBoard(
  actor: ObraActorContext,
  date?: string,
  cache?: BoardCacheClient | null,
): Promise<CompanyBoard> {
  return readCompanyBoard(actor, parseDate(date, actor.traceId), cache);
}

/**
 * Returns `{current, previous, delta}` for the company board: the scope-state
 * snapshot labeled with `date` next to the one labeled `date − 7d`, same SQL
 * on both legs. See {@link ComparedCompanyBoard} for why the drift reads 0
 * within one request. The company org resolves through authorization, so the
 * `:prev7d` envelope is keyed after it; pass the `cache` through to also warm
 * the single-board keys.
 */
export async function getComparedCompanyBoard(
  actor: ObraActorContext,
  date?: string,
  compare?: string,
  cache?: BoardCacheClient | null,
): Promise<ComparedCompanyBoard> {
  parseCompare(compare, actor.traceId);
  const boardDate = parseDate(date, actor.traceId);
  const previousDate = shiftIsoDate(boardDate, -BOARD_COMPARE_DAYS);
  // The company org resolves through authorization inside `readCompanyBoard`,
  // so the `:prev7d` envelope key derives from the current leg (whose single
  // key is already warm by then). An envelope hit skips the previous leg;
  // a miss reads it and stores the envelope with the same TTL and fail-open
  // rule. No extra authorization runs: both legs keep their own audit row.
  const current = await readCompanyBoard(actor, boardDate, cache);
  const key = obrasCompanyComparedBoardKey(actor.tenantId, current.orgNodeId, boardDate);
  const cached = await getCachedBoard<ComparedCompanyBoard>(cache, key);
  if (cached !== null) return cached;
  const previous = await readCompanyBoard(actor, previousDate, cache);
  const compared: ComparedCompanyBoard = {
    current,
    previous,
    delta: diffCompanyBoards(current, previous),
  };
  await setCachedBoard(cache, key, compared, OBRAS_BOARD_TTL_SECONDS);
  return compared;
}

/**
 * Exports the company board as CSV (`GET .../board/export?format=csv`). Same
 * aggregate as the JSON board, one row, wide format. The optional `cache` is
 * forwarded to `getCompanyBoard`, so exports share the board key.
 */
export async function exportCompanyBoard(
  actor: ObraActorContext,
  date?: string,
  format?: string,
  cache?: BoardCacheClient | null,
): Promise<BoardExport> {
  parseExportFormat(format, actor.traceId);
  const board = await getCompanyBoard(actor, date, cache);
  return {
    filename: safeExportFilename(`tablero-empresa-${board.date}`, 'tablero-empresa.csv'),
    contentType: BOARD_EXPORT_CONTENT_TYPE,
    csv: companyBoardToCsv(board),
  };
}
