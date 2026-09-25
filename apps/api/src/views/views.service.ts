// Saved views (B1) — owner-scoped filter bags over the four list entities.
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the use case end to end:
//   1. build the actor from the request the tenant middleware already bound;
//   2. load the membership and run the central rule through `canActivate` —
//      which audits every denial as `access.denied`. Any membership of the
//      tenant passes: views are a personal productivity tool, not a vertical,
//      so there is no role gate beyond "belongs to this tenant"
//      (`moduleActive: true`, same rationale as webhook/API-key management);
//   3. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every write, append one `audit_log` row.
//
// Scope contract (`tenant + user`):
// - A view is visible when it belongs to the tenant AND (`user_id` is the
//   caller OR `shared` is true OR `user_id` is NULL). NULL-owner rows are
//   legacy/global rows: visible, never API-mutable.
// - Mutations (PATCH/DELETE) require ownership (`user_id` = caller). A shared
//   view owned by someone else answers 403 `view.not_owner`; an invisible one
//   answers 404, so existence never leaks across private views.
// - DELETE is a soft delete (`active = FALSE`); PATCH may set it back.
//
// Filter contract (exact equality, no GIN):
// - `entity` is a closed list (`patients`, `appointments`, `invoices`,
//   `attendance`); `filters` is a flat bag of scalar `col = value`
//   equalities whose keys must belong to the entity allowlist below. No
//   operators, no nesting, no arrays — without a GIN index on `filters`
//   anything fancier would scan while reading as supported.
// - `resolveSavedViewForList` + `buildSavedViewConditions` are the integration
//   points for `?saved_view_id=` on the existing listings. They live here so
//   the four list services share one allowlist; each listing wires them with
//   two lines (see the recipe at the bottom of this file).
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';

/** List entities a view may target — a closed list, never free text. */
export const SAVED_VIEW_ENTITIES = ['patients', 'appointments', 'invoices', 'attendance'] as const;

export type SavedViewEntity = (typeof SAVED_VIEW_ENTITIES)[number];

/** Rows a list endpoint returns at most; keeps a stray wide scan bounded. */
export const SAVED_VIEW_LIST_LIMIT = 200;

/** Hard cap on filter entries per view (form + JSONB bag stay reviewable). */
export const MAX_SAVED_VIEW_FILTERS = 20;

/** Longest filter key or string value the service stores. */
export const MAX_SAVED_VIEW_TEXT_LENGTH = 200;

/** Physical column type behind one filter key (parameter binding only). */
type SavedViewFilterKind = 'text' | 'uuid' | 'boolean';

/**
 * Exact-equality allowlist: filter key → physical column. Every key maps to
 * one column of its entity's table and the listing applies it as a
 * parameterized `"col" = $n` predicate — no string interpolation, no
 * operators. Mirrors `SAVED_VIEW_FILTER_KEYS` (contracts `views.ts`); the two
 * change in the same work unit, never a silent drift.
 */
export const SAVED_VIEW_FILTER_COLUMNS: Record<SavedViewEntity, Record<string, { column: string; kind: SavedViewFilterKind }>> = {
  patients: {
    active: { column: 'active', kind: 'boolean' },
    documentType: { column: 'document_type', kind: 'text' },
    documentNumber: { column: 'document_number', kind: 'text' },
    orgNodeId: { column: 'org_node_id', kind: 'uuid' },
  },
  appointments: {
    status: { column: 'status', kind: 'text' },
    patientId: { column: 'patient_id', kind: 'uuid' },
    professionalId: { column: 'professional_id', kind: 'uuid' },
    orgNodeId: { column: 'org_node_id', kind: 'uuid' },
  },
  invoices: {
    status: { column: 'status', kind: 'text' },
    cashSessionId: { column: 'cash_session_id', kind: 'uuid' },
    serie: { column: 'serie', kind: 'text' },
    customerDocNumber: { column: 'customer_doc_number', kind: 'text' },
    fiscalStatus: { column: 'fiscal_status', kind: 'text' },
  },
  attendance: {
    status: { column: 'status', kind: 'text' },
    siteId: { column: 'site_id', kind: 'uuid' },
    userId: { column: 'user_id', kind: 'uuid' },
    source: { column: 'source', kind: 'text' },
  },
};

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface ViewsClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Framework-free request shape the controller forwards (structural). */
export interface ViewsRequest {
  headers?: Record<string, string | string[] | undefined>;
  tenant?: { tenantId: string; userId: string; scopes: readonly string[] };
  tenantClient?: ViewsClient;
}

/** Everything a use case needs from the request, framework-free. */
export interface ViewsActor {
  readonly client: ViewsClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly traceId: string;
  readonly ip: string | null;
}

/** One saved view as the list endpoints return it. */
export interface SavedViewRecord {
  readonly id: string;
  readonly tenantId: string;
  /** Owner; `null` rows are legacy/global rows: visible, never API-mutable. */
  readonly userId: string | null;
  readonly entity: SavedViewEntity;
  readonly filters: Record<string, string | number | boolean>;
  readonly shared: boolean;
  readonly active: boolean;
}

/** Validated `POST /v1/views` body. */
export interface SavedViewCreateInput {
  readonly entity: SavedViewEntity;
  readonly filters: Record<string, string | number | boolean>;
  readonly shared: boolean;
}

/** Validated `PATCH /v1/views/:id` body — owner only, ≥1 field. */
export interface SavedViewUpdateInput {
  readonly entity: SavedViewEntity | undefined;
  readonly filters: Record<string, string | number | boolean> | undefined;
  readonly shared: boolean | undefined;
  readonly active: boolean | undefined;
}

/** A resolved view ready for a listing to apply (`?saved_view_id=`). */
export interface ResolvedSavedView {
  readonly view: SavedViewRecord;
  readonly filters: Record<string, string | number | boolean>;
}

/** Parameterized equality predicates a listing ANDs onto its own scope. */
export interface SavedViewConditions {
  readonly clauses: readonly string[];
  readonly values: readonly unknown[];
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

/** 404 envelope for a view missing, invisible, inactive or foreign. */
function notFound(traceId: string): HttpException {
  return new HttpException({ code: 'not_found', message: 'Saved view not found', traceId }, 404);
}

/** 403 envelope for a visible view the caller does not own. */
function notOwner(traceId: string): HttpException {
  return new HttpException(
    { code: 'view.not_owner', message: 'Only the owner can change this view', traceId },
    403,
  );
}

// ============ request → actor ============

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
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
 * bound (`tenant` + `tenantClient`).
 */
export function actorFromViewsRequest(req: ViewsRequest): ViewsActor {
  const tenant = req.tenant;
  const client = req.tenantClient;
  if (tenant === undefined || client === undefined) {
    throw new HttpException(
      {
        code: 'tenant.missing',
        message: 'Request has no tenant context',
        traceId: readHeader(req.headers, 'x-trace-id') ?? 'unknown',
      },
      403,
    );
  }
  const traceId = readHeader(req.headers, 'x-trace-id') ?? 'unknown';
  const forwarded = readHeader(req.headers, 'x-forwarded-for');
  return {
    client,
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    traceId,
    ip: forwarded === undefined ? null : (forwarded.split(',')[0]?.trim() ?? null),
  };
}

// ============ row mapping ============

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
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

/** `pg` hands timestamptz back as `Date`; normalize to ISO, keep nulls. */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Normalizes the `filters` JSONB payload onto the scalar bag shape. */
function readFilters(value: unknown): Record<string, string | number | boolean> {
  if (typeof value === 'string') {
    try {
      return readFilters(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const filters: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      filters[key] = entry;
    }
  }
  return filters;
}

/** Maps a raw `saved_views` row onto the wire shape. */
export function mapSavedViewRow(row: Record<string, unknown>): SavedViewRecord {
  const entity = readString(row.entity) ?? '';
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    userId: readString(row.user_id) ?? null,
    entity: (SAVED_VIEW_ENTITIES as readonly string[]).includes(entity)
      ? (entity as SavedViewEntity)
      : 'patients',
    filters: readFilters(row.filters),
    shared: readBoolean(row.shared),
    active: readBoolean(row.active),
  };
}

// ============ SQL ============

const SAVED_VIEW_COLUMNS = 'id, tenant_id, user_id, entity, filters, shared, active';

/** Visibility predicate: own rows, shared rows of the tenant, legacy NULL rows. */
const VISIBILITY_SQL = '(user_id = $2 OR shared = TRUE OR user_id IS NULL)';

const SELECT_VIEW_SQL = `SELECT ${SAVED_VIEW_COLUMNS}
FROM saved_views WHERE tenant_id = $1 AND id = $2 AND ${VISIBILITY_SQL.replaceAll('$2', '$3')}`;

const LIST_VIEWS_SQL = `SELECT ${SAVED_VIEW_COLUMNS}
FROM saved_views WHERE tenant_id = $1 AND active = TRUE AND ${VISIBILITY_SQL}
ORDER BY id LIMIT ${SAVED_VIEW_LIST_LIMIT}`;

const LIST_VIEWS_ENTITY_SQL = `SELECT ${SAVED_VIEW_COLUMNS}
FROM saved_views WHERE tenant_id = $1 AND active = TRUE AND entity = $3 AND ${VISIBILITY_SQL}
ORDER BY id LIMIT ${SAVED_VIEW_LIST_LIMIT}`;

const INSERT_VIEW_SQL = `INSERT INTO saved_views
  (tenant_id, user_id, entity, filters, shared, active)
VALUES ($1, $2, $3, $4::jsonb, $5, TRUE)
RETURNING ${SAVED_VIEW_COLUMNS}`;

const UPDATE_VIEW_SQL = `UPDATE saved_views
SET entity = COALESCE($4, entity),
    filters = COALESCE($5::jsonb, filters),
    shared = COALESCE($6, shared),
    active = COALESCE($7, active)
WHERE id = $1 AND tenant_id = $2 AND user_id = $3
RETURNING ${SAVED_VIEW_COLUMNS}`;

const SOFT_DELETE_VIEW_SQL = `UPDATE saved_views
SET active = FALSE
WHERE id = $1 AND tenant_id = $2 AND user_id = $3
RETURNING ${SAVED_VIEW_COLUMNS}`;

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

// ============ guard ============

/**
 * Any membership of the tenant passes: views are personal productivity over
 * the caller's own lists, not a vertical, so there is no role gate beyond
 * belonging to the tenant. Runs the central rule so every denial is audited
 * as `access.denied` with the caller-visible reason. There is no
 * tenant-module gate (`moduleActive: true`): views serve every list surface.
 */
async function authorizeMember(
  actor: ViewsActor,
  attemptedAction: string,
): Promise<MembershipRecord> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: [], scope: [] },
    membership,
    entityOrgNodeId: membership?.orgNodeId ?? actor.tenantId,
    scopeSubtree: membership === null ? [] : [membership.orgNodeId],
    rolePermits: membership !== null,
    stateAllows: true,
    moduleActive: true,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'saved_view',
      entityId: null,
      orgNodeId: membership?.orgNodeId ?? null,
      attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return membership as MembershipRecord;
}

/** Appends one row per successful view write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: ViewsActor,
  membership: MembershipRecord,
  action: string,
  viewId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    action,
    'saved_view',
    viewId,
    membership.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...diff }),
    actor.ip,
  ]);
}

// ============ input validation ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

function parseEntity(value: unknown, traceId: string): SavedViewEntity {
  if (typeof value === 'string' && (SAVED_VIEW_ENTITIES as readonly string[]).includes(value)) {
    return value as SavedViewEntity;
  }
  throw badRequest(
    `entity must be one of ${(SAVED_VIEW_ENTITIES as readonly string[]).join(', ')}`,
    traceId,
  );
}

function parseFilterValue(value: unknown, key: string, traceId: string): string | number | boolean {
  if (typeof value === 'string') {
    if (value.length > MAX_SAVED_VIEW_TEXT_LENGTH) {
      throw badRequest(`Filter "${key}" exceeds ${MAX_SAVED_VIEW_TEXT_LENGTH} characters`, traceId);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw badRequest(`Filter "${key}" must be finite`, traceId);
    return value;
  }
  if (typeof value === 'boolean') return value;
  throw badRequest(
    `Filter "${key}" must be a string, number or boolean (exact equality only)`,
    traceId,
  );
}

/**
 * Validates a filter bag for one entity: flat object, entry cap, camelCase
 * keys inside the entity allowlist, scalar values. Mirrors
 * `savedViewCreateInputSchema` (contracts).
 */
export function parseViewFilters(
  value: unknown,
  entity: SavedViewEntity,
  traceId: string,
): Record<string, string | number | boolean> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('filters must be a JSON object of exact equalities', traceId);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SAVED_VIEW_FILTERS) {
    throw badRequest(`filters must hold at most ${MAX_SAVED_VIEW_FILTERS} entries`, traceId);
  }
  const allowed = SAVED_VIEW_FILTER_COLUMNS[entity];
  const filters: Record<string, string | number | boolean> = {};
  for (const [key, raw] of entries) {
    if (!FILTER_KEY_RE.test(key) || key.length > 80 || allowed[key] === undefined) {
      throw badRequest(
        `Unknown filter key for ${entity}: expected one of ${Object.keys(allowed).join(', ')}`,
        traceId,
      );
    }
    filters[key] = parseFilterValue(raw, key, traceId);
  }
  return filters;
}

function parseShared(value: unknown, traceId: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw badRequest('shared must be a boolean', traceId);
}

/** Validates the create body; mirrors `savedViewCreateInputSchema` (contracts). */
export function parseViewCreateInput(body: unknown, traceId: string): SavedViewCreateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with entity, filters and shared', traceId);
  }
  const record = body as Record<string, unknown>;
  const entity = parseEntity(record.entity, traceId);
  return {
    entity,
    filters: parseViewFilters(record.filters, entity, traceId),
    shared: parseShared(record.shared, traceId),
  };
}

/** Validates the update body; mirrors `savedViewUpdateInputSchema` (contracts). */
export function parseViewUpdateInput(
  body: unknown,
  storedEntity: SavedViewEntity,
  traceId: string,
): SavedViewUpdateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with entity, filters, shared or active', traceId);
  }
  const record = body as Record<string, unknown>;
  const hasEntity = record.entity !== undefined;
  const hasFilters = record.filters !== undefined;
  const hasShared = record.shared !== undefined;
  const hasActive = record.active !== undefined;
  if (!hasEntity && !hasFilters && !hasShared && !hasActive) {
    throw badRequest('Body must include at least one of entity, filters, shared or active', traceId);
  }
  const entity = hasEntity ? parseEntity(record.entity, traceId) : undefined;
  if (hasShared && typeof record.shared !== 'boolean') {
    throw badRequest('shared must be a boolean', traceId);
  }
  if (hasActive && typeof record.active !== 'boolean') {
    throw badRequest('active must be a boolean', traceId);
  }
  // Filters validate against the *target* entity: the incoming one when the
  // same PATCH retargets the view, the stored one otherwise.
  const filters = hasFilters
    ? parseViewFilters(record.filters, entity ?? storedEntity, traceId)
    : undefined;
  return {
    entity,
    filters,
    shared: hasShared ? (record.shared as boolean) : undefined,
    active: hasActive ? (record.active as boolean) : undefined,
  };
}

/**
 * Parses the query of `GET /v1/views`. The entity filter is optional; an
 * unknown entity is a 400, never a silently unfiltered list.
 */
export function parseViewsQuery(query: unknown, traceId: string): { entity: SavedViewEntity | null } {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const raw = record.entity;
  if (raw === undefined || raw === null || raw === '') return { entity: null };
  if (typeof raw !== 'string') throw badRequest('entity must be a string', traceId);
  return { entity: parseEntity(raw.trim(), traceId) };
}

function requireUuidParam(value: string, traceId: string): string {
  const trimmed = value?.trim() ?? '';
  if (!UUID_RE.test(trimmed)) throw badRequest('Invalid view id', traceId);
  return trimmed;
}

// ============ management use cases ============

/**
 * `POST /v1/views` — stores one filter bag. The row is owned by the caller
 * (`user_id`) and starts active; `shared` controls tenant-wide visibility.
 */
export async function createSavedView(
  actor: ViewsActor,
  body: unknown,
): Promise<SavedViewRecord> {
  const input = parseViewCreateInput(body, actor.traceId);
  const membership = await authorizeMember(actor, 'saved_view.create');
  const result = await actor.client.query(INSERT_VIEW_SQL, [
    actor.tenantId,
    actor.userId,
    input.entity,
    JSON.stringify(input.filters),
    input.shared,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Saved view insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const record = mapSavedViewRow(row);
  await writeAudit(actor, membership, 'saved_view.created', record.id, {
    entity: record.entity,
    shared: record.shared,
  });
  return record;
}

/** `GET /v1/views` — own active views plus shared ones of the tenant. */
export async function listSavedViews(
  actor: ViewsActor,
  query: unknown,
): Promise<SavedViewRecord[]> {
  const filters = parseViewsQuery(query, actor.traceId);
  await authorizeMember(actor, 'saved_view.list');
  const result =
    filters.entity === null
      ? await actor.client.query(LIST_VIEWS_SQL, [actor.tenantId, actor.userId])
      : await actor.client.query(LIST_VIEWS_ENTITY_SQL, [
          actor.tenantId,
          actor.userId,
          filters.entity,
        ]);
  return readRows(result).map(mapSavedViewRow);
}

/**
 * Loads one visible view or answers 404 — invisibility and absence share the
 * envelope so private-view existence never leaks.
 */
async function findVisibleView(actor: ViewsActor, viewId: string): Promise<SavedViewRecord> {
  const result = await actor.client.query(SELECT_VIEW_SQL, [
    actor.tenantId,
    viewId,
    actor.userId,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  return mapSavedViewRow(row);
}

/** `GET /v1/views/:id` — one visible view (private views of others are 404). */
export async function getSavedView(actor: ViewsActor, id: string): Promise<SavedViewRecord> {
  const viewId = requireUuidParam(id, actor.traceId);
  await authorizeMember(actor, 'saved_view.open');
  return findVisibleView(actor, viewId);
}

/**
 * `PATCH /v1/views/:id` — owner only. A visible-but-foreign (shared) view
 * answers 403 `view.not_owner`; an invisible one answers 404.
 */
export async function updateSavedView(
  actor: ViewsActor,
  id: string,
  body: unknown,
): Promise<SavedViewRecord> {
  const viewId = requireUuidParam(id, actor.traceId);
  const membership = await authorizeMember(actor, 'saved_view.update');
  const current = await findVisibleView(actor, viewId);
  if (current.userId === null || current.userId !== actor.userId) {
    throw notOwner(actor.traceId);
  }
  const input = parseViewUpdateInput(body, current.entity, actor.traceId);
  const result = await actor.client.query(UPDATE_VIEW_SQL, [
    viewId,
    actor.tenantId,
    actor.userId,
    input.entity ?? null,
    input.filters === undefined ? null : JSON.stringify(input.filters),
    input.shared ?? null,
    input.active ?? null,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  const record = mapSavedViewRow(row);
  await writeAudit(actor, membership, 'saved_view.updated', record.id, {
    entity: record.entity,
    shared: record.shared,
    active: record.active,
  });
  return record;
}

/**
 * `DELETE /v1/views/:id` — owner only, soft delete (`active = FALSE`).
 * The row stays for history; PATCH may set it back to `TRUE`.
 */
export async function removeSavedView(actor: ViewsActor, id: string): Promise<SavedViewRecord> {
  const viewId = requireUuidParam(id, actor.traceId);
  const membership = await authorizeMember(actor, 'saved_view.remove');
  const current = await findVisibleView(actor, viewId);
  if (current.userId === null || current.userId !== actor.userId) {
    throw notOwner(actor.traceId);
  }
  const result = await actor.client.query(SOFT_DELETE_VIEW_SQL, [
    viewId,
    actor.tenantId,
    actor.userId,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  const record = mapSavedViewRow(row);
  await writeAudit(actor, membership, 'saved_view.removed', record.id, { entity: record.entity });
  return record;
}

// ============ `?saved_view_id=` listing support ============

/**
 * Resolves `?saved_view_id=` for a listing of `expectedEntity`: the view must
 * be visible to the caller, active, tenant-scoped and targeted at the listing
 * being read. Answers 404 for a missing/invisible/inactive view and 400 when
 * the view targets another entity — a mismatch is a caller bug, loud by
 * design, never a silently ignored filter.
 *
 * Precondition: the caller already ran its own listing guard (these reads add
 * no scope beyond what the listing enforces in SQL).
 */
export async function resolveSavedViewForList(
  actor: ViewsActor,
  savedViewId: string,
  expectedEntity: SavedViewEntity,
): Promise<ResolvedSavedView> {
  const viewId = requireUuidParam(savedViewId, actor.traceId);
  if (!(SAVED_VIEW_ENTITIES as readonly string[]).includes(expectedEntity)) {
    throw badRequest('Invalid listing entity', actor.traceId);
  }
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  if (membership === null) throw accessDenied('membership.inactive', actor.traceId);
  const result = await actor.client.query(
    `SELECT ${SAVED_VIEW_COLUMNS} FROM saved_views ` +
      `WHERE tenant_id = $1 AND id = $2 AND active = TRUE AND ${VISIBILITY_SQL.replaceAll('$2', '$3')}`,
    [actor.tenantId, viewId, actor.userId],
  );
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  const view = mapSavedViewRow(row);
  if (view.entity !== expectedEntity) {
    throw badRequest(
      `Saved view targets ${view.entity}, not ${expectedEntity}`,
      actor.traceId,
    );
  }
  // Re-validate stored filters against the allowlist: rows predate deploys,
  // and a stale key must fail loudly instead of building a wrong predicate.
  const filters = parseViewFilters(view.filters, view.entity, actor.traceId);
  return { view, filters };
}

/**
 * Builds parameterized exact-equality predicates (`"col" = $n`, ANDed) for a
 * resolved filter bag. `$startIndex` is the next free placeholder of the
 * listing query, so the predicates compose with the listing's own scope
 * conditions without renumbering.
 *
 * Limit note (documented, not silent): plain equality, no GIN — the sweep is
 * over the listing's already scope-capped page (<=200 rows), which is the
 * accepted cost. Range/partial matches are out of scope for B1 on purpose.
 */
export function buildSavedViewConditions(
  entity: SavedViewEntity,
  filters: Record<string, string | number | boolean>,
  startIndex: number,
  traceId: string,
): SavedViewConditions {
  const allowlist = SAVED_VIEW_FILTER_COLUMNS[entity];
  if (allowlist === undefined) throw badRequest('Invalid listing entity', traceId);
  const clauses: string[] = [];
  const values: unknown[] = [];
  let index = startIndex;
  for (const [key, value] of Object.entries(filters)) {
    const mapping = allowlist[key];
    if (mapping === undefined) {
      throw badRequest(`Unknown filter key for ${entity}: ${key}`, traceId);
    }
    if (mapping.kind === 'uuid' && (typeof value !== 'string' || !UUID_RE.test(value))) {
      throw badRequest(`Filter "${key}" must be a UUID`, traceId);
    }
    if (mapping.kind === 'boolean' && typeof value !== 'boolean') {
      throw badRequest(`Filter "${key}" must be a boolean`, traceId);
    }
    values.push(value);
    clauses.push(`"${mapping.column}" = $${index}`);
    index += 1;
  }
  return { clauses, values };
}

// ============ `?saved_view_id=` wiring recipe (outside this task's surface)
//
// Each listing wires the two helpers with two lines: resolve the view, then
// AND its predicates into the listing's own scope conditions. Exact snippets:
//
// patients (`apps/api/src/salud/salud.service.ts:listPatients`, controller
// `patients.controller.ts:list` gains `@Query('saved_view_id') savedViewId?`):
//   import { buildSavedViewConditions, resolveSavedViewForList } from '../views/views.service.ts';
//   const extra = savedViewId ? await resolveSavedViewForList(actor, savedViewId, 'patients') : null;
//   const { clauses, values } = extra ? buildSavedViewConditions('patients', extra.filters, 3, actor.traceId) : ...
//
// appointments (`salud.service.ts:listAppointments`): same shape with
// `'appointments'`; invoices (`billing.service.ts:listInvoices`, which already
// takes `query: unknown`): read `saved_view_id` from the query record and
// resolve with `'invoices'`, appending to its `conditions`/`values`; attendance
// (`obras.service.ts:dayAttendance`, `site`+`date` stay required): resolve with
// `'attendance'` after `requireSiteAccess` and AND the predicates into
// `DAY_ATTENDANCE_SQL` via the same conditions builder.
