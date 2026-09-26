// Crews listing service — cuadrillas of `005_obras.sql` (P2-4a).
//
// Plain module with no decorators, like `obras.service.ts` and
// `resources.service.ts`, so the suite loads it under Node's strip-only
// TypeScript and the controller stays a thin HTTP skin. This module owns two
// reads over `crews`:
//   - `listCrews`: the legacy bare array, alphabetical and capped at
//     `CREW_LIST_LIMIT` (200);
//   - `listCrewsPage`: the opt-in R1 keyset page `{rows, nextCursor}`.
//
// Guard (coherent with the staff listing in `obras.service.ts`): the central
// rule through `canActivate` with `site.read` — the same read action the site
// file and the staff reads require — over the membership subtree, auditing
// every denial as `access.denied`. A successful read writes no audit row:
// reads are not writes (§4.4). The optional `?orgNodeId=` filter ANDs with
// the subtree scope, so a node outside the caller scope simply matches
// nothing instead of leaking.
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction } from '../auth/policy.ts';
import { OBRA_LIST_LIMIT, OBRA_MODULE, type ObraActorContext, type ObraClient } from './obras.service.ts';

/** Rows the crews listing returns at most; keeps a stray wide scan bounded. */
export const CREW_LIST_LIMIT = OBRA_LIST_LIMIT;

// ============ keyset pagination (R1) ============

/**
 * Default/max page size for the keyset crews listing; mirrors
 * `PAGINATION_DEFAULT_LIMIT` / `PAGINATION_MAX_LIMIT` in
 * `packages/contracts/src/pagination.ts`. The API keeps its own constants so
 * the runtime has no cross-package import; the values must stay 200/200 on
 * both sides.
 */
export const CREW_PAGE_DEFAULT_LIMIT = CREW_LIST_LIMIT;
export const CREW_PAGE_MAX_LIMIT = CREW_LIST_LIMIT;

/** `?cursor=` + `?limit=` input for the keyset crews listing (filters ride alongside). */
export interface CrewPageInput {
  readonly orgNodeId?: string | null;
  readonly active?: boolean | string | null;
  readonly cursor?: string | null;
  readonly limit?: number | string | null;
}

/** One keyset page: the rows plus the opaque cursor for the next page (null = end). */
export interface CrewPage<T> {
  readonly rows: T[];
  readonly nextCursor: string | null;
}

/** Normalizes `?limit=`: absent/empty uses 200, above 200 clamps, anything else outside 1..200 is a 400. */
function parseCrewPageLimit(raw: number | string | null | undefined, traceId: string): number {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return CREW_PAGE_DEFAULT_LIMIT;
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be an integer between 1 and 200', traceId);
  }
  return Math.min(parsed, CREW_PAGE_MAX_LIMIT);
}

/** Encodes one ordering key as the opaque `nextCursor` (base64url JSON, same shape as `encodeCursor` in the contracts). */
function encodeCrewPageCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes `?cursor=` back to its ordering key; any malformed input is a 400. */
function decodeCrewPageCursor(cursor: string, traceId: string): Record<string, string> {
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

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

/** 403 envelope when the caller has no reachable crew (scope denial). */
function scopeDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'obra.scope_denied', message: `Crew access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 400 envelope for a query param that fails validation. */
function badRequest(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'validation.failed', message, traceId }, 400);
}

// ============ record ============

/** One crew (`crews`): the display name plus its sede and activation flag. */
export interface CrewRecord {
  readonly id: string;
  readonly name: string;
  readonly orgNodeId: string;
  readonly active: boolean;
}

function mapCrew(row: Record<string, unknown>): CrewRecord {
  return {
    id: readString(row.id) ?? '',
    name: readString(row.name) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    active: readBoolean(row.active),
  };
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

/** Loads membership, subtree and obras module activation in the request client. */
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
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly attemptedAction?: string;
}

/** Runs the central rule with `site.read` and throws the scope envelope on deny. */
async function authorize(
  actor: ObraActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions,
): Promise<MembershipRecord> {
  const rolePermits =
    facts.membership !== null && rolePermitsAction(facts.membership.role, 'site.read');
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
      entity: 'crew',
      entityId: options.entityId ?? null,
      orgNodeId: options.orgNodeId,
      attemptedAction: options.attemptedAction ?? 'site.read',
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw scopeDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ filters ============

/** Filters of `GET /v1/obras/crews`: the sede and the activation flag. */
export interface CrewListFilters {
  readonly orgNodeId: string | null;
  readonly active: boolean | null;
}

/**
 * Parses the crews query. Every filter is optional and an empty string counts
 * as absent; a malformed UUID or an ambiguous boolean is a 400, never a
 * silently ignored filter.
 */
export function parseCrewListFilters(query: unknown, traceId: string): CrewListFilters {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const rawNode = record.orgNodeId ?? record.org_node_id;
  let orgNodeId: string | null = null;
  if (rawNode !== undefined && rawNode !== null) {
    if (typeof rawNode === 'string' && rawNode.trim() === '') {
      orgNodeId = null;
    } else if (typeof rawNode === 'string' && UUID_RE.test(rawNode.trim())) {
      orgNodeId = rawNode.trim();
    } else {
      throw badRequest('Invalid orgNodeId: expected a UUID', traceId);
    }
  }
  const rawActive = record.active;
  let active: boolean | null = null;
  if (rawActive === undefined || rawActive === null) {
    active = null;
  } else if (typeof rawActive === 'boolean') {
    active = rawActive;
  } else if (typeof rawActive === 'string' && rawActive.trim() === '') {
    active = null;
  } else if (typeof rawActive === 'string') {
    const lowered = rawActive.trim().toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 't') active = true;
    else if (lowered === 'false' || lowered === '0' || lowered === 'f') active = false;
    else throw badRequest(`Invalid active: ${String(rawActive)}`, traceId);
  } else {
    throw badRequest(`Invalid active: ${String(rawActive)}`, traceId);
  }
  return { orgNodeId, active };
}

// ============ SQL ============

const CREW_LIST_COLUMNS = 'c.id, c.org_node_id, c.name, c.active';

function buildCrewConditions(
  filters: CrewListFilters,
  values: unknown[],
): { conditions: string[]; values: unknown[] } {
  const conditions = ['c.tenant_id = $1', 'c.org_node_id = ANY($2::uuid[])'];
  if (filters.orgNodeId !== null) {
    values.push(filters.orgNodeId);
    conditions.push(`c.org_node_id = $${values.length}::uuid`);
  }
  if (filters.active !== null) {
    values.push(filters.active);
    conditions.push(`c.active = $${values.length}`);
  }
  return { conditions, values };
}

/**
 * Crews inside the membership subtree, alphabetical and capped at
 * `CREW_LIST_LIMIT`. Same read contract as `listSites`: the `site.read`
 * guard owns the denial audit and a successful read writes no audit row.
 */
export async function listCrews(
  actor: ObraActorContext,
  query: unknown = {},
): Promise<CrewRecord[]> {
  const filters = parseCrewListFilters(query, actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    orgNodeId: filters.orgNodeId ?? facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'crew.list',
  });
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  const { conditions } = buildCrewConditions(filters, values);
  const result = await actor.client.query(
    `SELECT ${CREW_LIST_COLUMNS} FROM crews c ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY c.name ASC, c.id ASC LIMIT ${CREW_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapCrew);
}

/**
 * Keyset page of the crews inside the membership subtree.
 *
 * Stable order: `name ASC, id ASC` — the legacy alphabetical order plus the
 * `id` tiebreaker, so equal names paginate deterministically (`name` carries
 * no UNIQUE). The cursor is the opaque base64url of the last row's
 * `{name, id}`; the query fetches `limit + 1` rows and a non-null
 * `nextCursor` means there is another page. Every filter ANDs with the
 * keyset predicate, so a filtered walk stays inside the filter.
 */
export async function listCrewsPage(
  actor: ObraActorContext,
  options: CrewPageInput = {},
): Promise<CrewPage<CrewRecord>> {
  const filters = parseCrewListFilters(options, actor.traceId);
  const limit = parseCrewPageLimit(options.limit, actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    orgNodeId: filters.orgNodeId ?? facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'crew.list',
  });
  let cursorName: string | null = null;
  let cursorId: string | null = null;
  const rawCursor = typeof options.cursor === 'string' ? options.cursor.trim() : '';
  if (rawCursor !== '') {
    const payload = decodeCrewPageCursor(rawCursor, actor.traceId);
    cursorName = payload.name ?? null;
    cursorId = payload.id ?? null;
    if (cursorName === null || cursorId === null) {
      throw badRequest('Invalid pagination cursor', actor.traceId);
    }
    if (!UUID_RE.test(cursorId)) throw badRequest('Invalid pagination cursor', actor.traceId);
  }
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  const { conditions } = buildCrewConditions(filters, values);
  if (cursorName !== null && cursorId !== null) {
    values.push(cursorName, cursorId);
    const nameParam = values.length - 1;
    const idParam = values.length;
    conditions.push(
      `(c.name > $${nameParam} OR ` +
        `(c.name = $${nameParam} AND c.id > $${idParam}::uuid))`,
    );
  }
  const result = await actor.client.query(
    `SELECT ${CREW_LIST_COLUMNS} FROM crews c ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY c.name ASC, c.id ASC LIMIT ${limit + 1}`,
    values,
  );
  const rows = readRows(result).map(mapCrew);
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (last === undefined) return { rows: page, nextCursor: null };
  return { rows: page, nextCursor: encodeCrewPageCursor({ name: last.name, id: last.id }) };
}
