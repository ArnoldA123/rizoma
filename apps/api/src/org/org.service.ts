// Org domain service — org tree listing for the P2 selectors
// (odd/tasks/ux-p2-nombres-uuid.md P2-0c).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the whole request use case:
//   1. parse the `?kind=` / `?active=` / `?parent=` filters (malformed = 400);
//   2. build the guard facts (membership, org-node subtree, tenant modules)
//      and evaluate the single central rule through `canActivate` — which
//      audits every denial as `access.denied` — refusing on denial;
//   3. run the tenant-scoped SQL (RLS already bound the transaction). Reads
//      write no audit row (§4.4).
//
// Scope rule: the listing is bounded by `subtree(membership.org_node_id)` —
// there is no tenant-global read. A caller without a membership denies before
// any row is touched. The read gate is transversal on purpose: the P2
// selectors serve every vertical, so any operational read grant
// (`agenda.read`, `patient.read`, `site.read`, `invoice.issue`) permits the
// listing, while the transversal no-grant roles (`vendedor`, `soporte`) and
// unknown roles stay denied. Roles and actions are the existing demo matrix
// (`auth/policy.ts`); no new action code was introduced.
//
// Keyset pagination (R1) mirrors `listSitesPage` / `listPatientsPage`: without
// `?cursor=` / `?limit=` the legacy bare array (cap 200, `name ASC, id ASC`)
// is returned unchanged; with either, the `{rows, nextCursor}` page is
// returned instead, ordered by the stable `name ASC, id ASC` (the legacy
// order plus the `id` tiebreaker, so equal names paginate deterministically).
// The cursor is the opaque base64url of the last row's `{name, id}`; the
// query fetches `limit + 1` rows and a non-null `nextCursor` means there is
// another page. Every filter ANDs with the keyset predicate, so a filtered
// walk stays inside the filter.
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import type { HeaderRecord, TenantScopedRequest } from '../tenant/tenant.middleware.ts';

/** Rows a list endpoint returns at most; keeps a stray wide scan bounded. */
export const ORG_LIST_LIMIT = 200;

// ============ keyset pagination (R1) ============

/**
 * Default/max page size; mirrors `PAGINATION_DEFAULT_LIMIT` /
 * `PAGINATION_MAX_LIMIT` in `packages/contracts/src/pagination.ts`. The API
 * keeps its own constants so the runtime has no cross-package import; the
 * values must stay 200/200 on both sides.
 */
export const ORG_PAGE_DEFAULT_LIMIT = ORG_LIST_LIMIT;
export const ORG_PAGE_MAX_LIMIT = ORG_LIST_LIMIT;

/** `?cursor=` + `?limit=` input for the keyset listing. */
export interface OrgPageInput {
  readonly cursor?: string | null;
  readonly limit?: number | string | null;
}

/** One keyset page: the rows plus the opaque cursor for the next page (null = end). */
export interface OrgPage<T> {
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
  if (raw === null) return ORG_PAGE_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be an integer between 1 and 200', traceId);
  }
  return Math.min(parsed, ORG_PAGE_MAX_LIMIT);
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
export interface OrgClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Everything a use case needs from the request, framework-free. */
export interface OrgActorContext {
  readonly client: OrgClient;
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
export function actorFromRequest(req: TenantScopedRequest): OrgActorContext {
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
 * Transversal read gate: the org tree serves every vertical, so the listing
 * stays available when any operational module is active (`salud` or `obras`).
 * A tenant with only `crm-core` denies, exactly like the vertical listings.
 */
async function transversalModuleActive(client: OrgClient, tenantId: string): Promise<boolean> {
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
  client: OrgClient,
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
async function loadFacts(actor: OrgActorContext): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await transversalModuleActive(actor.client, actor.tenantId);
  return { membership, scopeSubtree, moduleActive };
}

/**
 * Operational read grants that permit the org listing. Any one of them
 * suffices: the selectors serve every vertical, so a salud reader
 * (`agenda.read`), a clinical writer (`patient.read`), a construction role
 * (`site.read`) and the cashier (`invoice.issue`) all reach the tree. Roles
 * with no grant in the demo matrix (`vendedor`, `soporte`, unknown) deny.
 */
const ORG_READ_ACTIONS: readonly ActionCode[] = [
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
  actor: OrgActorContext,
  facts: ActorFacts,
  options: { entity: string; orgNodeId: string; attemptedAction: string },
): Promise<MembershipRecord> {
  const role = facts.membership?.role ?? '';
  const rolePermits =
    facts.membership !== null &&
    ORG_READ_ACTIONS.some((action) => rolePermitsAction(role, action));
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

/** `org_nodes.kind` — the CHECK of `001_core_foundation.sql`. */
export const ORG_NODE_KINDS = [
  'empresa',
  'sede',
  'sucursal',
  'area',
  'proyecto',
  'obra',
  'especialidad',
] as const;

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

/** Non-empty query value, or null when absent/blank (an empty string counts as absent). */
function readOptionalFilter(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ============ row shape ============

export interface OrgNodeRecord {
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  active: boolean;
  /** IANA timezone of the sede (P4-1a, `org_nodes.timezone`); never empty. */
  timezone: string;
}

/** Fallback sede zone (P4-1a): a node with no usable zone reads as Lima. */
export const ORG_DEFAULT_TIMEZONE = 'America/Lima';

/** True when `value` is a usable IANA timezone (backed by `Intl`). */
export function isValidOrgTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Usable zone of one row, or the Lima fallback (never throws). */
export function normalizeOrgTimezone(value: unknown): string {
  return isValidOrgTimezone(value) ? (value as string) : ORG_DEFAULT_TIMEZONE;
}

const ORG_NODE_COLUMNS = 'id, tenant_id, parent_id, kind, name, active, timezone';

function mapOrgNode(row: Record<string, unknown>): OrgNodeRecord {
  return {
    id: readString(row.id) ?? '',
    parentId: readString(row.parent_id) ?? null,
    kind: readString(row.kind) ?? '',
    name: readString(row.name) ?? '',
    active: readBoolean(row.active),
    timezone: normalizeOrgTimezone(row.timezone),
  };
}

// ============ filters ============

export interface OrgNodeFilters {
  readonly kind: string | null;
  readonly active: boolean | null;
  readonly parent: string | null;
}

/**
 * Parses `?kind=` / `?active=` / `?parent=`: an empty string counts as absent;
 * an unknown kind, a non-boolean active or a malformed parent UUID is a 400,
 * never a silently ignored filter.
 */
export function parseOrgNodeFilters(query: unknown, traceId: string): OrgNodeFilters {
  const record = asRecord(query);
  const rawKind = readOptionalFilter(record.kind);
  if (rawKind !== null && !(ORG_NODE_KINDS as readonly string[]).includes(rawKind)) {
    throw badRequest(`Invalid kind: ${rawKind}`, traceId);
  }
  const rawActive = readOptionalFilter(record.active);
  let active: boolean | null = null;
  if (rawActive !== null) {
    const lowered = rawActive.toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 't') active = true;
    else if (lowered === 'false' || lowered === '0' || lowered === 'f') active = false;
    else throw badRequest(`Invalid active: ${rawActive}`, traceId);
  }
  const rawParent = readOptionalFilter(record.parent ?? record.parentId);
  if (rawParent !== null && !UUID_RE.test(rawParent)) {
    throw badRequest('Invalid parent: expected a UUID', traceId);
  }
  return { kind: rawKind, active, parent: rawParent };
}

// ============ listing ============

/**
 * Org nodes inside the membership subtree, alphabetical, capped at
 * `ORG_LIST_LIMIT`. The guard owns the denial audit and a successful read
 * writes no audit row — reads are not writes (§4.4).
 */
export async function listOrgNodes(
  actor: OrgActorContext,
  query: unknown,
): Promise<OrgNodeRecord[]> {
  const filters = parseOrgNodeFilters(query, actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'org_node',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'org_node.list',
  });
  const conditions = ['tenant_id = $1', 'id = ANY($2::uuid[])'];
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  if (filters.kind !== null) {
    values.push(filters.kind);
    conditions.push(`kind = $${values.length}`);
  }
  if (filters.active !== null) {
    values.push(filters.active);
    conditions.push(`active = $${values.length}`);
  }
  if (filters.parent !== null) {
    values.push(filters.parent);
    conditions.push(`parent_id = $${values.length}::uuid`);
  }
  const result = await actor.client.query(
    `SELECT ${ORG_NODE_COLUMNS} FROM org_nodes ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY name ASC, id ASC LIMIT ${ORG_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapOrgNode);
}

/**
 * Keyset page of the org nodes inside the membership subtree.
 *
 * Stable order: `name ASC, id ASC` — the legacy `ORDER BY name ASC` plus the
 * `id` tiebreaker, so equal names paginate deterministically. The cursor is
 * the opaque base64url of the last row's `{name, id}`; the query fetches
 * `limit + 1` rows and a non-null `nextCursor` means there is another page.
 */
export async function listOrgNodesPage(
  actor: OrgActorContext,
  query: unknown,
): Promise<OrgPage<OrgNodeRecord>> {
  const record = asRecord(query);
  const filters = parseOrgNodeFilters(query, actor.traceId);
  const limit = parsePageLimit(readPageParam(record.limit), actor.traceId);
  let cursorName: string | null = null;
  let cursorId: string | null = null;
  const rawCursor = readPageParam(record.cursor);
  if (rawCursor !== null) {
    const payload = decodePageCursor(rawCursor, actor.traceId);
    cursorName = payload.name ?? null;
    cursorId = payload.id ?? null;
    if (cursorName === null || cursorId === null) {
      throw badRequest('Invalid pagination cursor', actor.traceId);
    }
    if (!UUID_RE.test(cursorId)) throw badRequest('Invalid pagination cursor', actor.traceId);
  }
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'org_node',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'org_node.list',
  });
  const conditions = ['tenant_id = $1', 'id = ANY($2::uuid[])'];
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  if (filters.kind !== null) {
    values.push(filters.kind);
    conditions.push(`kind = $${values.length}`);
  }
  if (filters.active !== null) {
    values.push(filters.active);
    conditions.push(`active = $${values.length}`);
  }
  if (filters.parent !== null) {
    values.push(filters.parent);
    conditions.push(`parent_id = $${values.length}::uuid`);
  }
  if (cursorName !== null && cursorId !== null) {
    values.push(cursorName, cursorId);
    const nameParam = values.length - 1;
    const idParam = values.length;
    conditions.push(
      `(name > $${nameParam} OR (name = $${nameParam} AND id > $${idParam}::uuid))`,
    );
  }
  const result = await actor.client.query(
    `SELECT ${ORG_NODE_COLUMNS} FROM org_nodes ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY name ASC, id ASC LIMIT ${limit + 1}`,
    values,
  );
  const rows = readRows(result).map(mapOrgNode);
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (last === undefined) return { rows: page, nextCursor: null };
  return { rows: page, nextCursor: encodePageCursor({ name: last.name, id: last.id }) };
}
