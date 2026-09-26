// Users domain service — personnel listing for the P2 selectors
// (odd/tasks/ux-p2-nombres-uuid.md P2-0c).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the whole request use case:
//   1. parse the `?orgNodeId=` / `?role=` / `?active=` filters (malformed = 400);
//   2. build the guard facts (membership, org-node subtree, tenant modules)
//      and evaluate the single central rule through `canActivate` — which
//      audits every denial as `access.denied` — refusing on denial;
//   3. run the tenant-scoped SQL (RLS already bound the transaction). Reads
//      write no audit row (§4.4).
//
// Scope rule: rows are the active memberships whose org node sits inside
// `subtree(membership.org_node_id)` — the same reach the `listSiteStaff`
// staff listing enforces, lifted from one site to the whole subtree so the
// P2 person selectors work across sedes. There is no tenant-global read.
//
// Privacy (PII): the SELECT lists its columns explicitly and they are exactly
// `u.id, u.name, u.email` plus the membership context — `phone` and
// `mfa_enrolled` exist on `users` (`001_core_foundation.sql`) but no query in
// this module selects them, so they can never leak through this listing. The
// read gate mirrors the staff listings: any operational read grant
// (`agenda.read`, `patient.read`, `site.read`, `invoice.issue`) permits the
// listing, while the transversal no-grant roles (`vendedor`, `soporte`) and
// unknown roles stay denied. Roles and actions are the existing demo matrix
// (`auth/policy.ts`); no new action code was introduced.
//
// Keyset pagination (R1) mirrors `listInvoices` / `listPatientsPage`: without
// `?cursor=` / `?limit=` the legacy bare array (cap 200,
// `created_at DESC, id DESC`) is returned unchanged; with either, the
// `{rows, nextCursor}` page is returned instead, ordered by the stable
// `created_at DESC, id DESC` (the legacy order plus the `id` tiebreaker;
// `created_at` is NOT NULL per `001_core_foundation.sql`, so the tuple
// comparison never meets a NULL). The cursor is the opaque base64url of the
// last row's `{createdAt, id}`; the query fetches `limit + 1` rows and a
// non-null `nextCursor` means there is another page. Every filter ANDs with
// the keyset predicate, so a filtered walk stays inside the filter.
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { ROLE_CODES, rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import type { HeaderRecord, TenantScopedRequest } from '../tenant/tenant.middleware.ts';

/** Rows a list endpoint returns at most; keeps a stray wide scan bounded. */
export const USER_LIST_LIMIT = 200;

// ============ keyset pagination (R1) ============

/**
 * Default/max page size; mirrors `PAGINATION_DEFAULT_LIMIT` /
 * `PAGINATION_MAX_LIMIT` in `packages/contracts/src/pagination.ts`. The API
 * keeps its own constants so the runtime has no cross-package import; the
 * values must stay 200/200 on both sides.
 */
export const USER_PAGE_DEFAULT_LIMIT = USER_LIST_LIMIT;
export const USER_PAGE_MAX_LIMIT = USER_LIST_LIMIT;

/** One keyset page: the rows plus the opaque cursor for the next page (null = end). */
export interface UserPage<T> {
  readonly rows: T[];
  readonly nextCursor: string | null;
}

/** Reads a non-empty pagination param from the list query, or null when absent/blank. */
function readPageParam(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Normalizes `?limit=`: absent/empty uses 200, above 200 clamps, anything else outside 1..200 is a 400. */
function parsePageLimit(raw: string | null, traceId: string): number {
  if (raw === null) return USER_PAGE_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be an integer between 1 and 200', traceId);
  }
  return Math.min(parsed, USER_PAGE_MAX_LIMIT);
}

/** Encodes one ordering key as the opaque `nextCursor` (base64url JSON, same shape as `encodeCursor` in the contracts). */
function encodePageCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes `?cursor=` back to its ordering key; any malformed input is a 400. */
function decodePageCursor(cursor: string, traceId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw badRequest('Invalid pagination cursor', traceId);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Invalid pagination cursor', traceId);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') throw badRequest('Invalid pagination cursor', traceId);
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw badRequest('Invalid pagination cursor', traceId);
  return out;
}

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface UserClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Everything a use case needs from the request, framework-free. */
export interface UserActorContext {
  readonly client: UserClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly traceId: string;
  readonly ip: string | null;
}

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
export function actorFromRequest(req: TenantScopedRequest): UserActorContext {
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

/**
 * Transversal read gate: the personnel listing serves every vertical, so it
 * stays available when any operational module is active (`salud` or `obras`).
 * A tenant with only `crm-core` denies, exactly like the vertical listings.
 */
async function transversalModuleActive(client: UserClient, tenantId: string): Promise<boolean> {
  const result = await client.query(SELECT_TENANT_MODULES_SQL, [tenantId]);
  const modules = readRows(result)[0]?.modules;
  return (
    Array.isArray(modules) && (modules.includes('salud') || modules.includes('obras'))
  );
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
  client: UserClient,
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
async function loadFacts(actor: UserActorContext): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await transversalModuleActive(actor.client, actor.tenantId);
  return { membership, scopeSubtree, moduleActive };
}

/**
 * Operational read grants that permit the personnel listing — the same reach
 * the staff listings grant their readers, extended across verticals so the P2
 * selectors work for salud and obras alike. Roles with no grant in the demo
 * matrix (`vendedor`, `soporte`, unknown) deny.
 */
const USER_READ_ACTIONS: readonly ActionCode[] = [
  'agenda.read',
  'patient.read',
  'site.read',
  'invoice.issue',
];

/**
 * Runs the single central rule and audits a denial. Returns the membership on
 * allow; throws a 403 envelope on deny (the denial row is already written by
 * `canActivate`, inside the same request transaction).
 */
async function authorize(
  actor: UserActorContext,
  facts: ActorFacts,
  options: { entity: string; orgNodeId: string; attemptedAction: string },
): Promise<MembershipRecord> {
  const role = facts.membership?.role ?? '';
  const rolePermits =
    facts.membership !== null &&
    USER_READ_ACTIONS.some((action) => rolePermitsAction(role, action));
  // `audit_log.org_node_id` is a FK to `org_nodes` and the tenant id is not a
  // node id: without a membership the audit row records NULL so the denial
  // insert never aborts the request transaction (MVP1 W2F).
  const auditOrgNodeId = facts.membership === null ? null : options.orgNodeId;
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
      entityId: null,
      orgNodeId: auditOrgNodeId,
      attemptedAction: options.attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** `timestamptz` may arrive as `Date` or string; normalize or null. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Non-empty query value, or null when absent/blank (an empty string counts as absent). */
function readOptionalFilter(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ============ row shape ============

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  orgNodeId: string;
  role: string;
  active: boolean;
}

/**
 * PII allowlist: exactly the columns the listing may read. `phone` and
 * `mfa_enrolled` live on `users` but are deliberately absent here — the
 * mapping below cannot emit what the SQL never selects.
 */
const USER_LIST_COLUMNS =
  'u.id, u.tenant_id, u.name, u.email, u.active, u.created_at, m.org_node_id, m.role';

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: readString(row.id) ?? '',
    name: readString(row.name) ?? '',
    email: readString(row.email) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    role: readString(row.role) ?? '',
    active: readBoolean(row.active),
  };
}

// ============ filters ============

export interface UserFilters {
  readonly orgNodeId: string | null;
  readonly role: string | null;
  readonly active: boolean | null;
}

/**
 * Parses `?orgNodeId=` / `?role=` / `?active=`: an empty string counts as
 * absent; a malformed org node UUID, an unknown role or a non-boolean active
 * is a 400, never a silently ignored filter.
 */
export function parseUserFilters(query: unknown, traceId: string): UserFilters {
  const record = asRecord(query);
  const rawNode = readOptionalFilter(record.orgNodeId ?? record.org_node_id);
  if (rawNode !== null && !UUID_RE.test(rawNode)) {
    throw badRequest('Invalid orgNodeId: expected a UUID', traceId);
  }
  const rawRole = readOptionalFilter(record.role);
  if (rawRole !== null && !(ROLE_CODES as readonly string[]).includes(rawRole)) {
    throw badRequest(`Invalid role: ${rawRole}`, traceId);
  }
  const rawActive = readOptionalFilter(record.active);
  let active: boolean | null = null;
  if (rawActive !== null) {
    const lowered = rawActive.toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 't') active = true;
    else if (lowered === 'false' || lowered === '0' || lowered === 'f') active = false;
    else throw badRequest(`Invalid active: ${rawActive}`, traceId);
  }
  return { orgNodeId: rawNode, role: rawRole, active };
}

// ============ listing ============

const USER_JOIN = `FROM users u
JOIN memberships m ON m.user_id = u.id AND m.tenant_id = u.tenant_id`;

/**
 * Personnel inside the membership subtree, newest first, capped at
 * `USER_LIST_LIMIT`: one row per active membership, so a person with two
 * memberships appears once per node. The guard owns the denial audit and a
 * successful read writes no audit row — reads are not writes (§4.4).
 */
export async function listUsers(
  actor: UserActorContext,
  query: unknown,
): Promise<UserRecord[]> {
  const filters = parseUserFilters(query, actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'user',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'user.list',
  });
  const conditions = ['u.tenant_id = $1', 'm.org_node_id = ANY($2::uuid[])', 'm.active = TRUE'];
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  if (filters.orgNodeId !== null) {
    values.push(filters.orgNodeId);
    conditions.push(`m.org_node_id = $${values.length}::uuid`);
  }
  if (filters.role !== null) {
    values.push(filters.role);
    conditions.push(`m.role = $${values.length}`);
  }
  if (filters.active !== null) {
    values.push(filters.active);
    conditions.push(`u.active = $${values.length}`);
  }
  const result = await actor.client.query(
    `SELECT ${USER_LIST_COLUMNS} ${USER_JOIN} ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY u.created_at DESC, u.id DESC LIMIT ${USER_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapUser);
}

/**
 * Keyset page of the personnel inside the membership subtree.
 *
 * Stable order: `created_at DESC, id DESC` — the legacy
 * `ORDER BY created_at DESC` plus the `id` tiebreaker, so equal timestamps
 * paginate deterministically (`created_at` is NOT NULL per
 * `001_core_foundation.sql`, so the tuple comparison never meets a NULL).
 * The cursor is the opaque base64url of the last row's `{createdAt, id}`;
 * the query fetches `limit + 1` rows and a non-null `nextCursor` means there
 * is another page.
 */
export async function listUsersPage(
  actor: UserActorContext,
  query: unknown,
): Promise<UserPage<UserRecord>> {
  const record = asRecord(query);
  const filters = parseUserFilters(query, actor.traceId);
  const limit = parsePageLimit(readPageParam(record.limit), actor.traceId);
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  const rawCursor = readPageParam(record.cursor);
  if (rawCursor !== null) {
    const payload = decodePageCursor(rawCursor, actor.traceId);
    cursorCreatedAt = payload.createdAt ?? null;
    cursorId = payload.id ?? null;
    if (cursorCreatedAt === null || cursorId === null) {
      throw badRequest('Invalid pagination cursor', actor.traceId);
    }
    if (Number.isNaN(Date.parse(cursorCreatedAt))) {
      throw badRequest('Invalid pagination cursor', actor.traceId);
    }
    if (!UUID_RE.test(cursorId)) throw badRequest('Invalid pagination cursor', actor.traceId);
  }
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'user',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'user.list',
  });
  const conditions = ['u.tenant_id = $1', 'm.org_node_id = ANY($2::uuid[])', 'm.active = TRUE'];
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  if (filters.orgNodeId !== null) {
    values.push(filters.orgNodeId);
    conditions.push(`m.org_node_id = $${values.length}::uuid`);
  }
  if (filters.role !== null) {
    values.push(filters.role);
    conditions.push(`m.role = $${values.length}`);
  }
  if (filters.active !== null) {
    values.push(filters.active);
    conditions.push(`u.active = $${values.length}`);
  }
  if (cursorCreatedAt !== null && cursorId !== null) {
    values.push(cursorCreatedAt, cursorId);
    const createdAtParam = values.length - 1;
    const idParam = values.length;
    conditions.push(
      `(u.created_at < $${createdAtParam}::timestamptz OR ` +
        `(u.created_at = $${createdAtParam}::timestamptz AND u.id < $${idParam}::uuid))`,
    );
  }
  const result = await actor.client.query(
    `SELECT ${USER_LIST_COLUMNS} ${USER_JOIN} ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY u.created_at DESC, u.id DESC LIMIT ${limit + 1}`,
    values,
  );
  // `u.created_at` rides in the raw rows for the cursor only: the contract
  // shape keeps `{id, name, email, orgNodeId, role, active}`, so the ordering
  // key is read here before the mapper drops it.
  const raw = readRows(result);
  const rows = raw.map(mapUser);
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const lastRaw = raw[limit - 1];
  const createdAt = toIso(lastRaw?.created_at);
  // `created_at` is NOT NULL, so the null branch is defensive only: without
  // an ordering key there is no cursor to offer, and ending here beats
  // emitting a cursor that the next call would reject.
  if (last === undefined || createdAt === null) return { rows: page, nextCursor: null };
  return { rows: page, nextCursor: encodePageCursor({ createdAt, id: last.id }) };
}
