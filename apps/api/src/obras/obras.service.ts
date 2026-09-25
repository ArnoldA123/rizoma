// Obras domain service — sites, assignments and attendance
// (bases-consolidadas-v1.md §2.4, §3.1, §3.4, §4.4).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controllers stay thin. The
// service owns the whole request use case:
//   1. build the guard facts (membership, org-node subtree, tenant module);
//   2. evaluate the single central rule through `canActivate` — which audits
//      every denial as `access.denied` — and refuse on denial;
//   3. layer the construction rule on top: an *active assignment* (an
//      `assignments` row whose `active` flag is set and whose `valid_from ..
//      valid_to` window contains the present) is the access key a worker
//      needs, while a manager whose membership subtree contains the site's
//      org node (gerente at company scope, jefe_obra at its own sites)
//      reaches it without one;
//   4. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every write, append one `audit_log` row.
//
// Field model: request/response use camelCase, the tables snake_case. Nothing
// here reads the environment and the clock is Postgres', so the assignment
// validity window is decided by the same clock that wrote the row.
//
// Error envelope: denials carry the `obra.*` codes the construction vertical
// documents (`obra.scope_denied`, `obra.access_denied`, `obra.approve_denied`,
// `obra.duplicate`). The underlying machine reason from the central rule rides
// in the payload, and every denial is written to `audit_log` as `access.denied`
// (by `canActivate` for the central rule, by the local checks otherwise).
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import type { HeaderRecord, TenantScopedRequest } from '../tenant/tenant.middleware.ts';

/** Tenant module this vertical requires (§3.1 property 6 / §3.5). */
export const OBRA_MODULE = 'obras';

/** Rows the list endpoints return at most; keeps a stray wide scan bounded. */
export const OBRA_LIST_LIMIT = 200;

/**
 * Roles that reach a site without an assignment because their membership
 * subtree already bounds them to it: `gerente` at company scope and
 * `jefe_obra` at its own sites (§3.4 "Ver obra" / "Personal"). Every other
 * construction role is assignment-scoped and needs an active row.
 */
const ORG_SCOPED_SITE_ROLES: readonly string[] = ['gerente', 'jefe_obra'];

/** Timestamped value (`timestamptz`/`date`) normalized to a plain string. */
type IsoValue = string | null;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface ObraClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Everything a use case needs from the request, framework-free. */
export interface ObraActorContext {
  readonly client: ObraClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly traceId: string;
  readonly ip: string | null;
}

// ============ error envelope ============

/** 403 envelope when the caller has no reachable site (scope or assignment). */
function scopeDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.scope_denied', message: `Site access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 403 envelope for an attendance mark that is not the caller's own. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.access_denied', message: `Attendance access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 403 envelope for an approval the caller may not perform. */
function approveDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.approve_denied', message: `Attendance approval denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 409 envelope for a site code already taken in the tenant. */
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

/** 400 envelope for an assignment target with no active membership. */
function membershipRequired(traceId: string): HttpException {
  return new HttpException(
    {
      code: 'obra.membership_required',
      message: 'The target user has no active membership in this tenant',
      traceId,
    },
    400,
  );
}

// ============ request → actor ============

function readHeader(headers: HeaderRecord | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

/**
 * Builds the actor context from the request the tenant middleware already
 * bound (`req.tenant` + `req.tenantClient`). `roles` stays empty: the guard's
 * role term is computed from `memberships.role`, and the JWT roles only feed
 * the denial audit diff.
 */
export function actorFromRequest(req: TenantScopedRequest): ObraActorContext {
  const tenant = req.tenant;
  const client = req.tenantClient;
  if (tenant === undefined || client === undefined) {
    throw new HttpException(
      { code: 'tenant.missing', message: 'Request has no tenant context', traceId: randomUUID() },
      403,
    );
  }
  const traceId = readHeader(req.headers, 'x-trace-id') ?? randomUUID();
  const forwarded = readHeader(req.headers, 'x-forwarded-for');
  return {
    client,
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    roles: [],
    traceId,
    ip: forwarded === undefined ? null : (forwarded.split(',')[0]?.trim() ?? null),
  };
}

// ============ guard facts ============

interface ActorFacts {
  readonly membership: MembershipRecord | null;
  readonly scopeSubtree: readonly string[];
  readonly moduleActive: boolean;
}

const SELECT_TENANT_MODULES_SQL = 'SELECT modules FROM tenants WHERE id = $1';

/** `action.module in tenant.modules` (§3.1); missing tenant/module = false. */
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

/** Descendants of the membership node, inclusive (§3.1 property 3). */
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

/** Loads membership, subtree and module activation in the request client. */
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
  /** Audit entity kind, e.g. `site`. */
  readonly entity: string;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly stateAllows?: boolean;
  readonly attemptedAction?: string;
  /** Builds the `obra.*` envelope thrown when the central rule denies. */
  readonly denied: (reason: string) => HttpException;
}

/**
 * Runs the single central rule and audits a denial. Returns the membership on
 * allow; throws the operation's `obra.*` envelope on deny (the `access.denied`
 * row is already written by `canActivate`, inside the same request
 * transaction).
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
  if (!decision.allow) throw options.denied(decision.reason);
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

/** Appends one row per successful write (§4.4); the correlation id rides in `diff`. */
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

/**
 * Writes the `access.denied` row for a denial the central rule did not see —
 * the assignment key, the own-attendance rule and the approval authority — and
 * then throws the given envelope (§3.1 property 6).
 */
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

/** SQLSTATE of a unique-constraint violation (a duplicate business key). */
const SQLSTATE_UNIQUE_VIOLATION = '23505';
/** SQLSTATE of a foreign-key violation (a dangling reference). */
const SQLSTATE_FK_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Runs an insert and maps the two client-caused constraint failures onto typed
 * 4xx envelopes: a duplicate business key as `obra.duplicate` and a dangling
 * reference as 400. Any other failure keeps propagating to the 500 path.
 */
async function insertObra(
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

// ============ value coercion ============

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

/** `timestamptz`/`date` may arrive as `Date` or string; normalize or null. */
function toIso(value: unknown): IsoValue {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ============ validation ============

const SITE_STATUSES = [
  'planned',
  'active',
  'suspended',
  'closing',
  'closed',
  'cancelled',
] as const;
type SiteStatus = (typeof SITE_STATUSES)[number];

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

interface SiteCreateInput {
  readonly orgNodeId: string;
  readonly code: string;
  readonly name: string;
  readonly clientName: string;
  readonly budgetTotal: number;
  readonly status: SiteStatus;
}

function parseSiteCreate(body: unknown, traceId: string): SiteCreateInput {
  const record = asRecord(body);
  let budgetTotal = 0;
  if (record.budgetTotal !== undefined && record.budgetTotal !== null) {
    const raw = record.budgetTotal;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw badRequest('budgetTotal must be a non-negative number', traceId);
    }
    budgetTotal = raw;
  }
  let status: SiteStatus = 'planned';
  if (record.status !== undefined && record.status !== null) {
    const raw = requireString(record, 'status', traceId);
    if (!(SITE_STATUSES as readonly string[]).includes(raw)) {
      throw badRequest(`Invalid site status: ${raw}`, traceId);
    }
    status = raw as SiteStatus;
  }
  return {
    orgNodeId: requireUuid(record, 'orgNodeId', traceId),
    code: requireString(record, 'code', traceId),
    name: requireString(record, 'name', traceId),
    clientName: requireString(record, 'clientName', traceId),
    budgetTotal,
    status,
  };
}

interface AssignmentCreateInput {
  readonly userId: string;
  readonly crewId: string | null;
  readonly roleInSite: string;
}

function parseAssignmentCreate(body: unknown, traceId: string): AssignmentCreateInput {
  const record = asRecord(body);
  return {
    userId: requireUuid(record, 'userId', traceId),
    crewId: optionalUuid(record, 'crewId', traceId),
    roleInSite: requireString(record, 'roleInSite', traceId),
  };
}

interface AttendanceMarkInput {
  readonly siteId: string;
  readonly userId: string | undefined;
  readonly source: string;
}

function parseAttendanceMark(body: unknown, traceId: string): AttendanceMarkInput {
  const record = asRecord(body);
  const siteId = requireUuid(record, 'siteId', traceId);
  const userId =
    record.userId === undefined || record.userId === null
      ? undefined
      : requireUuid(record, 'userId', traceId);
  const source = record.source === undefined || record.source === null
    ? 'web'
    : requireString(record, 'source', traceId);
  return { siteId, userId, source };
}

// ============ row shapes ============

export interface SiteRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  code: string;
  name: string;
  clientName: string;
  budgetTotal: number;
  startedAt: IsoValue;
  endedAt: IsoValue;
  status: string;
}

export interface AssignmentRecord {
  id: string;
  tenantId: string;
  userId: string;
  siteId: string;
  crewId: string | null;
  roleInSite: string;
  active: boolean;
  validFrom: IsoValue;
  validTo: IsoValue;
}

export interface SiteStaffRecord extends AssignmentRecord {
  userName: string;
  crewName: string | null;
}

export interface AttendanceRecord {
  id: string;
  tenantId: string;
  userId: string;
  siteId: string;
  checkIn: IsoValue;
  checkOut: IsoValue;
  source: string;
  status: string;
  approvedBy: string | null;
}

const SITE_COLUMNS =
  'id, tenant_id, org_node_id, code, name, client_name, budget_total, started_at, ended_at, status';
const ASSIGNMENT_COLUMNS =
  'id, tenant_id, user_id, site_id, crew_id, role_in_site, active, valid_from, valid_to';
const ATTENDANCE_COLUMNS =
  'id, tenant_id, user_id, site_id, check_in, check_out, source, status, approved_by';

function readNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
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

function mapAssignment(row: Record<string, unknown>): AssignmentRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    userId: readString(row.user_id) ?? '',
    siteId: readString(row.site_id) ?? '',
    crewId: readString(row.crew_id) ?? null,
    roleInSite: readString(row.role_in_site) ?? '',
    active: readBoolean(row.active),
    validFrom: toIso(row.valid_from),
    validTo: toIso(row.valid_to),
  };
}

function mapSiteStaff(row: Record<string, unknown>): SiteStaffRecord {
  return {
    ...mapAssignment(row),
    userName: readString(row.user_name) ?? '',
    crewName: readString(row.crew_name) ?? null,
  };
}

function mapAttendance(row: Record<string, unknown>): AttendanceRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    userId: readString(row.user_id) ?? '',
    siteId: readString(row.site_id) ?? '',
    checkIn: toIso(row.check_in),
    checkOut: toIso(row.check_out),
    source: readString(row.source) ?? '',
    status: readString(row.status) ?? '',
    approvedBy: readString(row.approved_by) ?? null,
  };
}

// ============ shared SQL ============

const SELECT_SITE_SQL = `SELECT ${SITE_COLUMNS}
FROM sites WHERE tenant_id = $1 AND id = $2`;
const LIST_SITES_SQL = `SELECT ${SITE_COLUMNS}
FROM sites WHERE tenant_id = $1 AND org_node_id = ANY($2::uuid[])
ORDER BY code LIMIT ${OBRA_LIST_LIMIT}`;
const INSERT_SITE_SQL = `INSERT INTO sites
  (tenant_id, org_node_id, code, name, client_name, budget_total, status)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING ${SITE_COLUMNS}`;

const SELECT_ACTIVE_ASSIGNMENT_SQL = `SELECT ${ASSIGNMENT_COLUMNS}
FROM assignments
WHERE tenant_id = $1 AND user_id = $2 AND site_id = $3
  AND active = TRUE
  AND valid_from <= now()
  AND (valid_to IS NULL OR valid_to >= now())
ORDER BY valid_from DESC
LIMIT 1`;
const INSERT_ASSIGNMENT_SQL = `INSERT INTO assignments
  (tenant_id, user_id, site_id, crew_id, role_in_site, active, valid_from)
VALUES ($1, $2, $3, $4, $5, TRUE, now())
RETURNING ${ASSIGNMENT_COLUMNS}`;
const CLOSE_ASSIGNMENT_SQL = `UPDATE assignments
SET active = FALSE, valid_to = now()
WHERE tenant_id = $1 AND id = $2
RETURNING ${ASSIGNMENT_COLUMNS}`;
const LIST_SITE_STAFF_SQL = `SELECT a.id, a.tenant_id, a.user_id, a.site_id, a.crew_id,
       a.role_in_site, a.active, a.valid_from, a.valid_to,
       u.name AS user_name, c.name AS crew_name
FROM assignments a
JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
LEFT JOIN crews c ON c.id = a.crew_id AND c.tenant_id = a.tenant_id
WHERE a.tenant_id = $1 AND a.site_id = $2
  AND a.active = TRUE
  AND a.valid_from <= now()
  AND (a.valid_to IS NULL OR a.valid_to >= now())
ORDER BY u.name LIMIT ${OBRA_LIST_LIMIT}`;

const SELECT_ATTENDANCE_SQL = `SELECT ${ATTENDANCE_COLUMNS}
FROM attendance WHERE tenant_id = $1 AND id = $2`;
const INSERT_ATTENDANCE_SQL = `INSERT INTO attendance
  (tenant_id, user_id, site_id, check_in, source, status)
VALUES ($1, $2, $3, now(), $4, 'registered')
RETURNING ${ATTENDANCE_COLUMNS}`;
const APPROVE_ATTENDANCE_SQL = `UPDATE attendance
SET status = 'approved', approved_by = $3
WHERE tenant_id = $1 AND id = $2 AND status = 'registered'
RETURNING ${ATTENDANCE_COLUMNS}`;
const DAY_ATTENDANCE_SQL = `SELECT ${ATTENDANCE_COLUMNS}
FROM attendance
WHERE tenant_id = $1 AND site_id = $2
  AND check_in >= $3::date
  AND check_in < ($3::date + INTERVAL '1 day')
ORDER BY check_in DESC LIMIT ${OBRA_LIST_LIMIT}`;

const SELECT_CREW_LEAD_SQL = `SELECT a.crew_id
FROM assignments a
JOIN crews c ON c.id = a.crew_id AND c.tenant_id = a.tenant_id
WHERE a.tenant_id = $1 AND a.user_id = $2 AND a.site_id = $3
  AND a.active = TRUE
  AND a.valid_from <= now()
  AND (a.valid_to IS NULL OR a.valid_to >= now())
  AND c.active = TRUE AND c.lead_membership_id = $4
LIMIT 1`;

/** Loads a site within the tenant; null means invisible/nonexistent. */
async function findSite(actor: ObraActorContext, siteId: string): Promise<SiteRecord | null> {
  if (!UUID_RE.test(siteId)) throw badRequest('Invalid site id', actor.traceId);
  const result = await actor.client.query(SELECT_SITE_SQL, [actor.tenantId, siteId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapSite(row);
}

async function findAttendance(
  actor: ObraActorContext,
  attendanceId: string,
): Promise<AttendanceRecord | null> {
  const result = await actor.client.query(SELECT_ATTENDANCE_SQL, [actor.tenantId, attendanceId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapAttendance(row);
}

// ============ assignment key ============

/**
 * The assignment in force for `userId` at `siteId`: the row is `active` and its
 * `valid_from .. valid_to` window contains the present. `null` means no access
 * key — a closed assignment, an expired window or none at all. Takes the actor
 * context so the query still carries `tenant_id` explicitly (§4.2).
 */
export async function activeAssignment(
  actor: ObraActorContext,
  userId: string,
  siteId: string,
): Promise<AssignmentRecord | null> {
  const result = await actor.client.query(SELECT_ACTIVE_ASSIGNMENT_SQL, [
    actor.tenantId,
    userId,
    siteId,
  ]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapAssignment(row);
}

/**
 * Resolves site access for one user. The central rule runs first (membership,
 * subtree, role `site.read`, tenant module), then the construction key: an
 * active assignment grants access, and a manager whose subtree covers the site
 * (`gerente`, `jefe_obra`) reaches it without one. Every other case is denied
 * with `obra.scope_denied` and audited.
 */
export async function requireSiteAccess(
  actor: ObraActorContext,
  userId: string,
  siteId: string,
): Promise<SiteRecord> {
  const site = await findSite(actor, siteId);
  if (site === null) throw notFound('site', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'site.read',
    entity: 'site',
    entityId: site.id,
    orgNodeId: site.orgNodeId,
    attemptedAction: 'site.access',
    denied: (reason) => scopeDenied(reason, actor.traceId),
  });
  const assignment = await activeAssignment(actor, userId, site.id);
  if (assignment !== null) return site;
  if (ORG_SCOPED_SITE_ROLES.includes(membership.role)) return site;
  return deny(actor, scopeDenied('no_active_assignment', actor.traceId), {
    reason: 'obra.scope_denied',
    entity: 'site',
    entityId: site.id,
    orgNodeId: site.orgNodeId,
    attemptedAction: 'site.access',
  });
}

// ============ sites ============

/** Sites inside the membership subtree (§3.4 "Ver obra"). */
export async function listSites(actor: ObraActorContext): Promise<SiteRecord[]> {
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'site.read',
    entity: 'site',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'site.list',
    denied: (reason) => scopeDenied(reason, actor.traceId),
  });
  const result = await actor.client.query(LIST_SITES_SQL, [
    actor.tenantId,
    [...facts.scopeSubtree],
  ]);
  return readRows(result).map(mapSite);
}

/** Creates a site; only `gerente` holds `site.write` (§3.4). */
export async function createSite(actor: ObraActorContext, body: unknown): Promise<SiteRecord> {
  const input = parseSiteCreate(body, actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'site.write',
    entity: 'site',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'site.create',
    denied: (reason) => scopeDenied(reason, actor.traceId),
  });
  const rows = await insertObra(actor, `Site code already exists: ${input.code}`, () =>
    actor.client.query(INSERT_SITE_SQL, [
      actor.tenantId,
      input.orgNodeId,
      input.code,
      input.name,
      input.clientName,
      input.budgetTotal,
      input.status,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Site insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const site = mapSite(row);
  await writeAudit(actor, membership, {
    action: 'site.created',
    entity: 'site',
    entityId: site.id,
    orgNodeId: site.orgNodeId,
    diff: { code: site.code, orgNodeId: site.orgNodeId, status: site.status },
  });
  return site;
}

/** Reads one site; its own org node drives the scope check. */
export async function getSite(actor: ObraActorContext, siteId: string): Promise<SiteRecord> {
  const site = await findSite(actor, siteId);
  if (site === null) throw notFound('site', actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'site.read',
    entity: 'site',
    entityId: site.id,
    orgNodeId: site.orgNodeId,
    attemptedAction: 'site.open',
    denied: (reason) => scopeDenied(reason, actor.traceId),
  });
  return site;
}

// ============ assignments ============

/**
 * Active assignments of a site with the worker and crew resolved. Access
 * follows {@link requireSiteAccess}, so an assignment-scoped role must itself
 * hold an active row and a manager must reach the site through its subtree.
 */
export async function listSiteStaff(
  actor: ObraActorContext,
  siteId: string,
): Promise<SiteStaffRecord[]> {
  const site = await requireSiteAccess(actor, actor.userId, siteId);
  const result = await actor.client.query(LIST_SITE_STAFF_SQL, [actor.tenantId, site.id]);
  return readRows(result).map(mapSiteStaff);
}

/**
 * Assigns a worker to a site. The caller must be `gerente` or `jefe_obra` in
 * its own site (`assignment.write`); the target must carry an active
 * membership. The call is idempotent by `user + site`: an assignment already
 * in force is returned untouched instead of duplicated.
 */
export async function assignWorker(
  actor: ObraActorContext,
  siteId: string,
  body: unknown,
): Promise<AssignmentRecord> {
  const input = parseAssignmentCreate(body, actor.traceId);
  const site = await findSite(actor, siteId);
  if (site === null) throw notFound('site', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'assignment.write',
    entity: 'assignment',
    orgNodeId: site.orgNodeId,
    attemptedAction: 'assignment.create',
    denied: (reason) => scopeDenied(reason, actor.traceId),
  });
  const target = await loadMembership(actor.client, input.userId, actor.tenantId);
  if (target === null || !target.active || target.userActive === false) {
    throw membershipRequired(actor.traceId);
  }
  const existing = await activeAssignment(actor, input.userId, site.id);
  if (existing !== null) return existing;
  const rows = await insertObra(actor, 'Assignment already exists', () =>
    actor.client.query(INSERT_ASSIGNMENT_SQL, [
      actor.tenantId,
      input.userId,
      site.id,
      input.crewId,
      input.roleInSite,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Assignment insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const assignment = mapAssignment(row);
  await writeAudit(actor, membership, {
    action: 'assignment.created',
    entity: 'assignment',
    entityId: assignment.id,
    orgNodeId: site.orgNodeId,
    diff: { userId: input.userId, siteId: site.id, roleInSite: input.roleInSite },
  });
  return assignment;
}

/**
 * Ends an assignment, which revokes the worker's site access on the next
 * decision (`active = FALSE` and `valid_to = now()`). Authority is the same as
 * {@link assignWorker}.
 */
export async function closeAssignment(
  actor: ObraActorContext,
  siteId: string,
  userId: string,
): Promise<AssignmentRecord> {
  if (!UUID_RE.test(userId)) throw badRequest('Invalid user id', actor.traceId);
  const site = await findSite(actor, siteId);
  if (site === null) throw notFound('site', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'assignment.write',
    entity: 'assignment',
    orgNodeId: site.orgNodeId,
    attemptedAction: 'assignment.close',
    denied: (reason) => scopeDenied(reason, actor.traceId),
  });
  const existing = await activeAssignment(actor, userId, site.id);
  if (existing === null) throw notFound('assignment', actor.traceId);
  const result = await actor.client.query(CLOSE_ASSIGNMENT_SQL, [actor.tenantId, existing.id]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Assignment close returned no row', traceId: actor.traceId },
      500,
    );
  }
  const assignment = mapAssignment(row);
  await writeAudit(actor, membership, {
    action: 'assignment.closed',
    entity: 'assignment',
    entityId: assignment.id,
    orgNodeId: site.orgNodeId,
    diff: { userId, siteId: site.id },
  });
  return assignment;
}

// ============ attendance ============

/**
 * Registers the caller's own attendance. A worker may only mark themselves
 * (`userId` in the body must equal the token subject) and only where an active
 * assignment gives them a key; anything else is `obra.access_denied`.
 */
export async function markAttendance(
  actor: ObraActorContext,
  body: unknown,
): Promise<AttendanceRecord> {
  const input = parseAttendanceMark(body, actor.traceId);
  const site = await findSite(actor, input.siteId);
  if (site === null) throw notFound('site', actor.traceId);
  if (input.userId !== undefined && input.userId !== actor.userId) {
    return deny(actor, accessDenied('attendance.not_own', actor.traceId), {
      reason: 'obra.access_denied',
      entity: 'attendance',
      orgNodeId: site.orgNodeId,
      attemptedAction: 'attendance.mark',
    });
  }
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'attendance.mark',
    entity: 'attendance',
    orgNodeId: site.orgNodeId,
    attemptedAction: 'attendance.mark',
    denied: (reason) => accessDenied(reason, actor.traceId),
  });
  const assignment = await activeAssignment(actor, actor.userId, site.id);
  if (assignment === null) {
    return deny(actor, accessDenied('no_active_assignment', actor.traceId), {
      reason: 'obra.access_denied',
      entity: 'attendance',
      orgNodeId: site.orgNodeId,
      attemptedAction: 'attendance.mark',
    });
  }
  const rows = await insertObra(actor, 'Attendance already exists', () =>
    actor.client.query(INSERT_ATTENDANCE_SQL, [
      actor.tenantId,
      actor.userId,
      site.id,
      input.source,
    ]),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Attendance insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const attendance = mapAttendance(row);
  await writeAudit(actor, membership, {
    action: 'attendance.marked',
    entity: 'attendance',
    entityId: attendance.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: site.id, userId: actor.userId, status: attendance.status },
  });
  return attendance;
}

/**
 * Approves one attendance mark. `capataz` may only approve the crew it leads,
 * `jefe_obra` only inside its own sites and `gerente` across the company;
 * `almacen` and `trabajador` never hold `attendance.approve`, so they are
 * denied. A mark that is no longer `registered` cannot be approved again.
 */
export async function approveAttendance(
  actor: ObraActorContext,
  attendanceId: string,
): Promise<AttendanceRecord> {
  if (!UUID_RE.test(attendanceId)) throw badRequest('Invalid attendance id', actor.traceId);
  const current = await findAttendance(actor, attendanceId);
  if (current === null) throw notFound('attendance', actor.traceId);
  const site = await findSite(actor, current.siteId);
  if (site === null) throw notFound('site', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'attendance.approve',
    entity: 'attendance',
    entityId: current.id,
    orgNodeId: site.orgNodeId,
    stateAllows: current.status === 'registered',
    attemptedAction: 'attendance.approve',
    denied: (reason) => approveDenied(reason, actor.traceId),
  });
  if (current.status !== 'registered') {
    return deny(actor, approveDenied('state.not_registered', actor.traceId), {
      reason: 'obra.state_denied',
      entity: 'attendance',
      entityId: current.id,
      orgNodeId: site.orgNodeId,
      attemptedAction: 'attendance.approve',
    });
  }
  const allowed =
    membership.role === 'capataz'
      ? await leadsWorkerCrew(actor, current.userId, site.id, membership.id)
      : membership.role === 'jefe_obra' || membership.role === 'gerente';
  if (!allowed) {
    return deny(
      actor,
      approveDenied(membership.role === 'capataz' ? 'crew.mismatch' : 'site.out_of_scope', actor.traceId),
      {
        reason: 'obra.approve_denied',
        entity: 'attendance',
        entityId: current.id,
        orgNodeId: site.orgNodeId,
        attemptedAction: 'attendance.approve',
      },
    );
  }
  const result = await actor.client.query(APPROVE_ATTENDANCE_SQL, [
    actor.tenantId,
    current.id,
    actor.userId,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Attendance approval returned no row', traceId: actor.traceId },
      500,
    );
  }
  const attendance = mapAttendance(row);
  await writeAudit(actor, membership, {
    action: 'attendance.approved',
    entity: 'attendance',
    entityId: attendance.id,
    orgNodeId: site.orgNodeId,
    diff: { siteId: site.id, userId: current.userId, from: 'registered', to: 'approved' },
  });
  return attendance;
}

/** True when the caller's membership leads the crew the worker belongs to. */
async function leadsWorkerCrew(
  actor: ObraActorContext,
  workerId: string,
  siteId: string,
  membershipId: string,
): Promise<boolean> {
  const result = await actor.client.query(SELECT_CREW_LEAD_SQL, [
    actor.tenantId,
    workerId,
    siteId,
    membershipId,
  ]);
  return readRows(result).length > 0;
}

/** Attendance marks of one day at one site (§3.4 "Asistencia"). */
export async function dayAttendance(
  actor: ObraActorContext,
  siteId: string,
  date: string,
): Promise<AttendanceRecord[]> {
  if (!DATE_RE.test(date)) throw badRequest('date must be YYYY-MM-DD', actor.traceId);
  const site = await requireSiteAccess(actor, actor.userId, siteId);
  const result = await actor.client.query(DAY_ATTENDANCE_SQL, [actor.tenantId, site.id, date]);
  return readRows(result).map(mapAttendance);
}
