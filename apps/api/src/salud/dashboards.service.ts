// Role dashboards (bases-consolidadas-v1.md §6.3).
//
// Deliberately plain, like `salud.service.ts` and `billing.service.ts`: no
// decorators, because `npm test` loads the sources through Node's strip-only
// TypeScript (which rejects decorators). The HTTP skin lives in
// `dashboards.controller.ts` and stays thin; this module owns the use case:
//   1. validate the requested board role, sede and date;
//   2. build the guard facts (membership, org-node subtree, tenant module) and
//      evaluate the central rule through `canActivate` — which audits every
//      denial as `access.denied` — refusing on denial;
//   3. run bounded tenant-scoped SQL for the board KPIs.
//
// §6.3 KPI contract:
//   * recepcion: citas del día, espera promedio, inasistencias y cola;
//   * caja:      cobros del día, facturas emitidas, pendientes fiscales y
//                arqueo (open session). No clinical field is selected here:
//                §6.1 keeps the amounts/invoices block for caja/dirección only;
//   * medico:    mis citas, episodios abiertos y consentimientos pendientes.
//
// Scope and policy: the requested board must match the caller's membership role
// (`rolePermits = role === membership.role && rolePermitsAction(...)`), so the
// caja board is not reachable from a clinical role that happens to share an
// action, and vice versa. The sede is the `?org` query param (default: the
// membership node) and must sit inside the membership subtree, which the guard
// already enforces.
//
// Read-path note (load-bearing, §6.3): the consolidated bases specify that the
// dashboards read the read replica with a 5–15 min Redis cache and never the
// primary. R2 adds the Redis half: `getBoard`/`getComparedBoard` read through
// `cache/boards.ts` (cache-aside, salud TTL 900s, fail-open to the primary).
// There is still no replica — the cache sits in front of the same request
// transaction connection — and v1 does no write invalidation: a board is
// fresh for its `{day}` window plus its TTL at most, matching the web poll
// rhythm. Every query stays bounded (`LIMIT`/aggregate); only the connection
// target (replica) is still a follow-up. The KPI contract and the HTTP
// surface do not change.
import { HttpException } from '@nestjs/common';
import {
  SALUD_BOARD_TTL_SECONDS,
  saludBoardKey,
  saludComparedBoardKey,
  withBoardCache,
  type BoardCacheClient,
} from '../cache/boards.ts';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

export type { ActorContext, SaludClient };

/** Boards §6.3 ships in MVP1. */
export const DASHBOARD_ROLES = ['recepcion', 'caja', 'medico'] as const;
export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

/** Action each board is gated on, through the §3.3 role × action matrix. */
const BOARD_ACTIONS: Record<DashboardRole, ActionCode> = {
  recepcion: 'agenda.read',
  caja: 'invoice.issue',
  medico: 'agenda.read',
};

/** Rows a row-returning board query may yield; the aggregates already collapse. */
export const DASHBOARD_LIST_LIMIT = 200;

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

// ============ error envelope ============

/** Domain envelope: `{code: 'dashboard.*', message, traceId}`. */
function dashboardError(code: string, message: string, status: number, traceId: string): HttpException {
  return new HttpException({ code, message, traceId }, status);
}

/** 403 envelope carrying the guard reason for observability. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
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

/** One decimal is enough for an average wait in minutes. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Two decimals keep cents in a collected-amount delta; counts stay exact. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Moves a `YYYY-MM-DD` day by whole days, staying in UTC. */
function shiftIsoDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
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

// ============ guard facts ============

interface ActorFacts {
  readonly membership: MembershipRecord | null;
  readonly scopeSubtree: readonly string[];
  readonly moduleActive: boolean;
}

const SELECT_TENANT_MODULES_SQL = 'SELECT modules FROM tenants WHERE id = $1';

async function tenantHasModule(
  client: SaludClient,
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
  client: SaludClient,
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

async function loadFacts(actor: ActorContext, module = 'salud'): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await tenantHasModule(actor.client, actor.tenantId, module);
  return { membership, scopeSubtree, moduleActive };
}

/**
 * Runs the central rule for one board and audits any denial before throwing
 * 403. The role term is the conjunction of the §3.3 action grant and the board
 * role identity, so the boards cannot be crossed.
 */
async function authorizeBoard(
  actor: ActorContext,
  facts: ActorFacts,
  role: DashboardRole,
  orgNodeId: string,
): Promise<MembershipRecord> {
  const rolePermits =
    facts.membership !== null &&
    facts.membership.role === role &&
    rolePermitsAction(facts.membership.role, BOARD_ACTIONS[role]);
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: actor.roles, scope: [] },
    membership: facts.membership,
    entityOrgNodeId: orgNodeId,
    scopeSubtree: [...facts.scopeSubtree],
    rolePermits,
    stateAllows: true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'dashboard',
      entityId: null,
      orgNodeId,
      attemptedAction: 'dashboard.read',
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ board shapes ============

export interface DashboardBase {
  readonly role: DashboardRole;
  readonly orgNodeId: string;
  /** `YYYY-MM-DD` the KPIs were filtered on. */
  readonly date: string;
}

/** §6.3 recepcion: citas del día, espera promedio, inasistencias y cola. */
export interface RecepcionBoard extends DashboardBase {
  readonly role: 'recepcion';
  readonly todayAppointments: number;
  /** Average minutes a patient has been waiting past their scheduled time. */
  readonly waitingAvgMin: number;
  readonly noShows: number;
  /** Patients currently `checked_in`/`in_care`. */
  readonly queue: number;
}

/** §6.3 caja: montos y estados only — no clinical data crosses this board. */
export interface CajaBoard extends DashboardBase {
  readonly role: 'caja';
  readonly todayCollected: number;
  readonly invoicesIssued: number;
  readonly fiscalPending: number;
  readonly openSession: { readonly id: string; readonly orgNodeId: string; readonly openedAt: string | null } | null;
}

/** §6.3 medico: mis citas, episodios abiertos y consentimientos pendientes. */
export interface MedicoBoard extends DashboardBase {
  readonly role: 'medico';
  readonly myAppointments: number;
  readonly openEpisodes: number;
  readonly pendingConsents: number;
}

export type DashboardBoard = RecepcionBoard | CajaBoard | MedicoBoard;

// ============ SQL ============

// Every query is bounded: row-returning statements carry a LIMIT and the KPI
// statements are aggregates (COUNT/SUM/AVG) that collapse to one row. The sede
// filter is the subtree of the requested org node, so a network board shows its
// sedes and a sede board shows only itself.
const RECEPCION_BOARD_SQL = `SELECT
  COUNT(*) FILTER (WHERE status <> 'cancelled') AS today_appointments,
  COUNT(*) FILTER (WHERE status = 'no_show') AS no_shows,
  COUNT(*) FILTER (WHERE status IN ('checked_in','in_care')) AS queue,
  COALESCE(AVG(EXTRACT(EPOCH FROM (now() - starts_at)) / 60)
    FILTER (WHERE status IN ('checked_in','in_care') AND starts_at < now()), 0) AS waiting_avg_min
FROM appointments
WHERE tenant_id = $1
  AND org_node_id = ANY($2::uuid[])
  AND starts_at >= $3::date
  AND starts_at < ($3::date + interval '1 day')
LIMIT 1`;

const CAJA_COLLECTED_SQL = `SELECT COALESCE(SUM(p.amount), 0) AS today_collected
FROM payments p
JOIN invoices i ON i.id = p.invoice_id AND i.tenant_id = p.tenant_id
WHERE p.tenant_id = $1
  AND i.org_node_id = ANY($2::uuid[])
  AND p.status = 'registered'
  AND p.paid_at >= $3::date
  AND p.paid_at < ($3::date + interval '1 day')
LIMIT 1`;

const CAJA_INVOICES_SQL = `SELECT COUNT(*) AS invoices_issued
FROM invoices
WHERE tenant_id = $1
  AND org_node_id = ANY($2::uuid[])
  AND issued_at >= $3::date
  AND issued_at < ($3::date + interval '1 day')
LIMIT 1`;

// The fiscal backlog is a current-state counter, not a day counter (§6.3
// «pendientes fiscales»), so it is intentionally not date-filtered.
const CAJA_FISCAL_SQL = `SELECT COUNT(*) AS fiscal_pending
FROM invoices
WHERE tenant_id = $1
  AND org_node_id = ANY($2::uuid[])
  AND fiscal_status = 'pending'
LIMIT 1`;

const CAJA_SESSION_SQL = `SELECT id, org_node_id, opened_at, status
FROM cash_sessions
WHERE tenant_id = $1
  AND org_node_id = ANY($2::uuid[])
  AND status = 'open'
ORDER BY opened_at DESC
LIMIT 1`;

const MEDICO_APPOINTMENTS_SQL = `SELECT COUNT(*) AS my_appointments
FROM appointments
WHERE tenant_id = $1
  AND professional_id = $2
  AND org_node_id = ANY($3::uuid[])
  AND starts_at >= $4::date
  AND starts_at < ($4::date + interval '1 day')
LIMIT 1`;

const MEDICO_EPISODES_SQL = `SELECT COUNT(*) AS open_episodes
FROM episodes
WHERE tenant_id = $1
  AND professional_id = $2
  AND status = 'open'
LIMIT 1`;

const MEDICO_CONSENTS_SQL = `SELECT COUNT(*) AS pending_consents
FROM consents c
JOIN patient_files p ON p.id = c.patient_id AND p.tenant_id = c.tenant_id
WHERE c.tenant_id = $1
  AND c.status = 'pending'
  AND p.org_node_id = ANY($2::uuid[])
LIMIT 1`;

// ============ request parsing ============

function parseRole(role: string, traceId: string): DashboardRole {
  if (!(DASHBOARD_ROLES as readonly string[]).includes(role)) {
    throw dashboardError(
      'dashboard.invalid_role',
      `Unknown dashboard role (expected ${DASHBOARD_ROLES.join('|')}): ${role}`,
      400,
      traceId,
    );
  }
  return role as DashboardRole;
}

function parseDate(raw: string | undefined, traceId: string): string {
  const value = raw?.trim() ?? '';
  if (value === '') return todayIsoDate();
  if (!isCalendarDate(value)) {
    throw dashboardError('dashboard.invalid_date', 'date must be a real YYYY-MM-DD date', 400, traceId);
  }
  return value;
}

function parseOrgNode(raw: string | undefined, fallback: string, traceId: string): string {
  const value = raw?.trim() ?? '';
  if (value === '') return fallback;
  if (!UUID_RE.test(value)) {
    throw dashboardError('dashboard.invalid_org_node', 'org must be a UUID', 400, traceId);
  }
  return value;
}

function parseCompare(raw: string | undefined, traceId: string): BoardCompareMode {
  const value = raw?.trim() ?? '';
  if (value === '') return 'previous-week';
  if (!(BOARD_COMPARE_MODES as readonly string[]).includes(value)) {
    throw dashboardError(
      'dashboard.invalid_compare',
      `Unknown compare mode (expected ${BOARD_COMPARE_MODES.join('|')}): ${value}`,
      400,
      traceId,
    );
  }
  return value as BoardCompareMode;
}

function parseExportFormat(raw: string | undefined, traceId: string): BoardExportFormat {
  const value = raw?.trim() ?? '';
  if (!(BOARD_EXPORT_FORMATS as readonly string[]).includes(value)) {
    throw dashboardError(
      'dashboard.invalid_format',
      `Unknown export format (expected ${BOARD_EXPORT_FORMATS.join('|')}): ${value === '' ? '(missing)' : value}`,
      400,
      traceId,
    );
  }
  return value as BoardExportFormat;
}

/**
 * Day-over-day comparison of one board: the board of `date` next to the
 * board of `date − 7d`, plus the per-KPI drift (`current − previous`).
 *
 * Both legs run the same parametrized SQL; only the date changes. KPIs that
 * are scope-state rather than day-state (caja `fiscalPending`/`openSession`,
 * medico `openEpisodes`/`pendingConsents`) read identically in both legs, so
 * their delta is 0 by construction — the day-filtered KPIs carry the signal.
 */
export interface ComparedDashboardBoard {
  readonly current: DashboardBoard;
  readonly previous: DashboardBoard;
  readonly delta: Record<string, number>;
}

/** One BI export: a CSV of the board aggregate with its safe filename. */
export interface BoardExport {
  readonly filename: string;
  readonly contentType: string;
  readonly csv: string;
}

// ============ use case ============

/**
 * Reads one board for one role, sede and day. The caller must already be
 * authorized for the board; this is the shared leg of `getBoard`,
 * `getComparedBoard` and `exportBoard`.
 */
async function readBoard(
  actor: ActorContext,
  boardRole: DashboardRole,
  targetOrg: string,
  scope: readonly string[],
  boardDate: string,
): Promise<DashboardBoard> {
  if (boardRole === 'recepcion') {
    const result = await actor.client.query(RECEPCION_BOARD_SQL, [actor.tenantId, scope, boardDate]);
    const row = readRows(result)[0] ?? {};
    return {
      role: 'recepcion',
      orgNodeId: targetOrg,
      date: boardDate,
      todayAppointments: toNumber(row.today_appointments),
      waitingAvgMin: round1(toNumber(row.waiting_avg_min)),
      noShows: toNumber(row.no_shows),
      queue: toNumber(row.queue),
    };
  }

  if (boardRole === 'caja') {
    const collected = await actor.client.query(CAJA_COLLECTED_SQL, [actor.tenantId, scope, boardDate]);
    const invoices = await actor.client.query(CAJA_INVOICES_SQL, [actor.tenantId, scope, boardDate]);
    const fiscal = await actor.client.query(CAJA_FISCAL_SQL, [actor.tenantId, scope]);
    const session = await actor.client.query(CAJA_SESSION_SQL, [actor.tenantId, scope]);
    const sessionRow = readRows(session)[0];
    return {
      role: 'caja',
      orgNodeId: targetOrg,
      date: boardDate,
      todayCollected: toNumber(readRows(collected)[0]?.today_collected),
      invoicesIssued: toNumber(readRows(invoices)[0]?.invoices_issued),
      fiscalPending: toNumber(readRows(fiscal)[0]?.fiscal_pending),
      openSession:
        sessionRow === undefined
          ? null
          : {
              id: readString(sessionRow.id) ?? '',
              orgNodeId: readString(sessionRow.org_node_id) ?? '',
              openedAt: toIso(sessionRow.opened_at),
            },
    };
  }

  const appointments = await actor.client.query(MEDICO_APPOINTMENTS_SQL, [
    actor.tenantId,
    actor.userId,
    scope,
    boardDate,
  ]);
  const episodes = await actor.client.query(MEDICO_EPISODES_SQL, [actor.tenantId, actor.userId]);
  const consents = await actor.client.query(MEDICO_CONSENTS_SQL, [actor.tenantId, scope]);
  return {
    role: 'medico',
    orgNodeId: targetOrg,
    date: boardDate,
    myAppointments: toNumber(readRows(appointments)[0]?.my_appointments),
    openEpisodes: toNumber(readRows(episodes)[0]?.open_episodes),
    pendingConsents: toNumber(readRows(consents)[0]?.pending_consents),
  };
}

/** Per-KPI drift (`current − previous`) of two same-role boards. */
function diffDashboardBoards(current: DashboardBoard, previous: DashboardBoard): Record<string, number> {
  if (current.role !== previous.role) return {};
  if (current.role === 'recepcion' && previous.role === 'recepcion') {
    return {
      todayAppointments: round2(current.todayAppointments - previous.todayAppointments),
      waitingAvgMin: round2(current.waitingAvgMin - previous.waitingAvgMin),
      noShows: round2(current.noShows - previous.noShows),
      queue: round2(current.queue - previous.queue),
    };
  }
  if (current.role === 'caja' && previous.role === 'caja') {
    return {
      todayCollected: round2(current.todayCollected - previous.todayCollected),
      invoicesIssued: round2(current.invoicesIssued - previous.invoicesIssued),
      fiscalPending: round2(current.fiscalPending - previous.fiscalPending),
    };
  }
  if (current.role === 'medico' && previous.role === 'medico') {
    return {
      myAppointments: round2(current.myAppointments - previous.myAppointments),
      openEpisodes: round2(current.openEpisodes - previous.openEpisodes),
      pendingConsents: round2(current.pendingConsents - previous.pendingConsents),
    };
  }
  return {};
}

/**
 * Filename of a board export. The role comes from the allowlist and the date
 * from the calendar check, so the name can only carry safe characters; the
 * guard below mirrors the strictness of the imports errors-CSV naming (never
 * a separator, a control character or a leading dot) as defense in depth.
 */
function safeExportFilename(role: DashboardRole, date: string): string {
  const candidate = `tablero-${role}-${date}.csv`;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(candidate) || candidate.startsWith('.')) {
    return 'tablero.csv';
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

/** The board aggregate as one CSV row (wide format, same numbers as the JSON). */
function boardToCsv(board: DashboardBoard): string {
  if (board.role === 'recepcion') {
    return csvTable(
      ['role', 'org_node_id', 'date', 'today_appointments', 'waiting_avg_min', 'no_shows', 'queue'],
      [[board.role, board.orgNodeId, board.date, board.todayAppointments, board.waitingAvgMin, board.noShows, board.queue]],
    );
  }
  if (board.role === 'caja') {
    return csvTable(
      ['role', 'org_node_id', 'date', 'today_collected', 'invoices_issued', 'fiscal_pending', 'open_session_id', 'open_session_org_node_id', 'open_session_opened_at'],
      [[board.role, board.orgNodeId, board.date, board.todayCollected, board.invoicesIssued, board.fiscalPending, board.openSession?.id ?? null, board.openSession?.orgNodeId ?? null, board.openSession?.openedAt ?? null]],
    );
  }
  return csvTable(
    ['role', 'org_node_id', 'date', 'my_appointments', 'open_episodes', 'pending_consents'],
    [[board.role, board.orgNodeId, board.date, board.myAppointments, board.openEpisodes, board.pendingConsents]],
  );
}

/**
 * Returns the board of `role` for one sede and day. The caller must be that
 * role; any other board is a 403 (`role.denied`) audited by the guard.
 *
 * Cache-aside (R2): with a `cache` (the shared `REDIS_CLIENT`), the bounded
 * primary SQL runs once per `{tenant, role, org, date}` per TTL (900s) and
 * repeated polls read Redis. Without it — or with Redis down — the read
 * falls through to the primary; the cache never turns a board into a 500.
 * Day-scoped writes do not invalidate in v1 (see `cache/boards.ts`).
 */
export async function getBoard(
  actor: ActorContext,
  role: string,
  orgNodeId?: string,
  date?: string,
  cache?: BoardCacheClient | null,
): Promise<DashboardBoard> {
  const boardRole = parseRole(role, actor.traceId);
  const facts = await loadFacts(actor);
  const fallbackOrg = facts.membership?.orgNodeId ?? actor.tenantId;
  const targetOrg = parseOrgNode(orgNodeId, fallbackOrg, actor.traceId);
  const boardDate = parseDate(date, actor.traceId);

  await authorizeBoard(actor, facts, boardRole, targetOrg);
  const scope = await loadScopeSubtree(actor.client, actor.tenantId, targetOrg);
  const key = saludBoardKey(actor.tenantId, boardRole, targetOrg, boardDate);
  return withBoardCache(cache, key, SALUD_BOARD_TTL_SECONDS, () =>
    readBoard(actor, boardRole, targetOrg, scope, boardDate),
  );
}

/**
 * Returns `{current, previous, delta}` for one board: the board of `date`
 * next to the board of `date − 7d`, with the same parametrized SQL on both
 * legs. Authorization and scope resolve once, so the comparison cannot widen
 * what `getBoard` allows. The envelope is cached under its own `:prev7d` key
 * with the same TTL and fail-open rule as `getBoard`.
 */
export async function getComparedBoard(
  actor: ActorContext,
  role: string,
  orgNodeId?: string,
  date?: string,
  compare?: string,
  cache?: BoardCacheClient | null,
): Promise<ComparedDashboardBoard> {
  parseCompare(compare, actor.traceId);
  const boardRole = parseRole(role, actor.traceId);
  const facts = await loadFacts(actor);
  const fallbackOrg = facts.membership?.orgNodeId ?? actor.tenantId;
  const targetOrg = parseOrgNode(orgNodeId, fallbackOrg, actor.traceId);
  const boardDate = parseDate(date, actor.traceId);

  await authorizeBoard(actor, facts, boardRole, targetOrg);
  const scope = await loadScopeSubtree(actor.client, actor.tenantId, targetOrg);
  const previousDate = shiftIsoDate(boardDate, -BOARD_COMPARE_DAYS);
  const key = saludComparedBoardKey(actor.tenantId, boardRole, targetOrg, boardDate);
  return withBoardCache(cache, key, SALUD_BOARD_TTL_SECONDS, async () => {
    const current = await readBoard(actor, boardRole, targetOrg, scope, boardDate);
    const previous = await readBoard(actor, boardRole, targetOrg, scope, previousDate);
    return { current, previous, delta: diffDashboardBoards(current, previous) };
  });
}

/**
 * Exports one board aggregate as CSV (`GET .../export?format=csv`). Same
 * aggregate and same bound as the JSON board, one row, wide format. The
 * optional `cache` is forwarded to `getBoard`, so exports share the board
 * keys instead of minting CSV ones.
 */
export async function exportBoard(
  actor: ActorContext,
  role: string,
  orgNodeId?: string,
  date?: string,
  format?: string,
  cache?: BoardCacheClient | null,
): Promise<BoardExport> {
  parseExportFormat(format, actor.traceId);
  const board = await getBoard(actor, role, orgNodeId, date, cache);
  return {
    filename: safeExportFilename(board.role, board.date),
    contentType: BOARD_EXPORT_CONTENT_TYPE,
    csv: boardToCsv(board),
  };
}
