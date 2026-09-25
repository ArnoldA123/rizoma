// Custom field definitions (B2) — typed extra keys over existing JSONB bags.
//
// `patient_files.contacts` (`module: 'salud'`, `entity: 'patient'`) and
// `triages.values` (`module: 'salud'`, `entity: 'triage'`) accept one value per
// `active` definition of their pair, checked on every write of those bags.
// Primitives only (`text|number|date|boolean`) plus `required`: no computed
// fields, no relations, no fully dynamic UI.
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the use case end to end:
//   1. build the actor from the request the tenant middleware already bound;
//   2. run the tenant-admin gate through the central rule (`canActivate` —
//      which audits every denial as `access.denied`): only `ti_admin` and
//      `direccion` manage definitions, the same custodians as API keys and
//      webhooks (`moduleActive: true`: definitions serve the tenant itself);
//   3. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every write, append one `audit_log` row.
//
// Enforcement on writes lives in `validateCustomValues` + `loadActiveDefs`,
// which the `salud` and `triages` services call after their own guard and
// before their insert/update: an unauthorized caller still gets 403, and an
// authorized caller with a bad custom value gets 400 `validation.failed`.
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { isTenantAdminRole } from '../auth/api-keys.ts';

/** Tenant module + entity pair typing `patient_files.contacts`. */
export const CUSTOM_FIELD_MODULE_SALUD = 'salud';
export const CUSTOM_FIELD_ENTITY_PATIENT = 'patient';
/** Tenant module + entity pair typing `triages.values`. */
export const CUSTOM_FIELD_ENTITY_TRIAGE = 'triage';

/** Value types a definition may declare — primitives only, no relations. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Lifecycle of a definition, mirroring the table CHECK. */
export const CUSTOM_FIELD_STATUSES = ['draft', 'active', 'retired'] as const;
export type CustomFieldStatus = (typeof CUSTOM_FIELD_STATUSES)[number];

/** Rows the list endpoint returns at most; keeps a stray wide scan bounded. */
export const CUSTOM_FIELD_LIST_LIMIT = 200;

/** `code` shape: `camelCase`/`snake_case` identifier, so it maps 1:1 to a bag key. */
export const CUSTOM_FIELD_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** `module`/`entity` shape: short namespace identifier, never free text. */
export const CUSTOM_FIELD_SCOPE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface CustomFieldClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Framework-free request shape the controller forwards (structural). */
export interface CustomFieldRequest {
  headers?: Record<string, string | string[] | undefined>;
  tenant?: { tenantId: string; userId: string; scopes: readonly string[] };
  tenantClient?: CustomFieldClient;
}

/** Everything a use case needs from the request, framework-free. */
export interface CustomFieldActor {
  readonly client: CustomFieldClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly traceId: string;
  readonly ip: string | null;
}

/** One definition as the API returns it. */
export interface CustomFieldDef {
  readonly id: string;
  readonly tenantId: string;
  readonly module: string;
  readonly entity: string;
  readonly code: string;
  readonly type: CustomFieldType;
  readonly required: boolean;
  readonly status: CustomFieldStatus;
}

/** Validated `POST /v1/custom-fields` body. */
export interface CustomFieldCreateInput {
  readonly module: string;
  readonly entity: string;
  readonly code: string;
  readonly type: CustomFieldType;
  readonly required: boolean;
  readonly status: CustomFieldStatus;
}

/** Validated `PATCH /v1/custom-fields/:id` body — ≥1 field. */
export interface CustomFieldUpdateInput {
  readonly type: CustomFieldType | undefined;
  readonly required: boolean | undefined;
  readonly status: CustomFieldStatus | undefined;
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

/** 404 envelope for a definition that does not exist in the tenant. */
function notFound(traceId: string): HttpException {
  return new HttpException(
    { code: 'not_found', message: 'Custom field definition not found', traceId },
    404,
  );
}

/** 409 envelope for a duplicate `(module, entity, code)` in the tenant. */
function duplicate(traceId: string): HttpException {
  return new HttpException(
    {
      code: 'duplicate',
      message: 'A custom field with that module, entity and code already exists',
      traceId,
    },
    409,
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
export function actorFromCustomFieldRequest(req: CustomFieldRequest): CustomFieldActor {
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

/** Maps a raw `custom_field_defs` row onto the wire shape. */
export function mapCustomFieldRow(row: Record<string, unknown>): CustomFieldDef {
  const type = readString(row.type) ?? '';
  const status = readString(row.status) ?? '';
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    module: readString(row.module) ?? '',
    entity: readString(row.entity) ?? '',
    code: readString(row.code) ?? '',
    type: (CUSTOM_FIELD_TYPES as readonly string[]).includes(type)
      ? (type as CustomFieldType)
      : 'text',
    required: readBoolean(row.required),
    status: (CUSTOM_FIELD_STATUSES as readonly string[]).includes(status)
      ? (status as CustomFieldStatus)
      : 'draft',
  };
}

// ============ SQL ============

const CUSTOM_FIELD_COLUMNS = 'id, tenant_id, module, entity, code, type, required, status';

const LIST_DEFS_SQL = `SELECT ${CUSTOM_FIELD_COLUMNS}
FROM custom_field_defs WHERE tenant_id = $1 ORDER BY code LIMIT ${CUSTOM_FIELD_LIST_LIMIT}`;

const LIST_DEFS_FILTERED_SQL = `SELECT ${CUSTOM_FIELD_COLUMNS}
FROM custom_field_defs WHERE tenant_id = $1 AND module = $2 AND entity = $3
ORDER BY code LIMIT ${CUSTOM_FIELD_LIST_LIMIT}`;

const LIST_ACTIVE_DEFS_SQL = `SELECT ${CUSTOM_FIELD_COLUMNS}
FROM custom_field_defs WHERE tenant_id = $1 AND module = $2 AND entity = $3 AND status = 'active'
ORDER BY code LIMIT ${CUSTOM_FIELD_LIST_LIMIT}`;

const SELECT_DEF_SQL = `SELECT ${CUSTOM_FIELD_COLUMNS}
FROM custom_field_defs WHERE tenant_id = $1 AND id = $2`;

const INSERT_DEF_SQL = `INSERT INTO custom_field_defs
  (tenant_id, module, entity, code, type, required, status)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING ${CUSTOM_FIELD_COLUMNS}`;

const UPDATE_DEF_SQL = `UPDATE custom_field_defs
SET type = COALESCE($4, type),
    required = COALESCE($5, required),
    status = COALESCE($6, status)
WHERE id = $1 AND tenant_id = $2
RETURNING ${CUSTOM_FIELD_COLUMNS}`;

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

// ============ guard ============

const SELECT_SUBTREE_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM org_nodes WHERE tenant_id = $1 AND id = $2
  UNION ALL
  SELECT n.id FROM org_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.tenant_id = $1
)
SELECT id FROM subtree`;

/**
 * The management gate: only an active, in-window tenant admin membership
 * passes (`ti_admin`, `direccion` — the same custodians as API keys). Runs
 * the central rule so every denial is audited as `access.denied` with the
 * caller-visible reason. There is no tenant-module gate
 * (`moduleActive: true`): definitions serve the tenant itself, not one
 * vertical.
 */
async function authorizeAdmin(
  actor: CustomFieldActor,
  attemptedAction: string,
): Promise<MembershipRecord> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree: string[] =
    membership === null
      ? []
      : readRows(await actor.client.query(SELECT_SUBTREE_SQL, [actor.tenantId, membership.orgNodeId]))
          .map((row) => row.id)
          .filter((id): id is string => typeof id === 'string');
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: [], scope: [] },
    membership,
    entityOrgNodeId: membership?.orgNodeId ?? actor.tenantId,
    scopeSubtree,
    rolePermits: membership !== null && isTenantAdminRole(membership.role),
    stateAllows: true,
    moduleActive: true,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'custom_field_def',
      entityId: null,
      orgNodeId: membership?.orgNodeId ?? null,
      attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return membership as MembershipRecord;
}

/** Appends one row per successful definition write (§4.4). */
async function writeAudit(
  actor: CustomFieldActor,
  membership: MembershipRecord,
  action: string,
  defId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    action,
    'custom_field_def',
    defId,
    membership.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...diff }),
    actor.ip,
  ]);
}

// ============ input validation ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseScope(value: unknown, key: string, traceId: string): string {
  if (typeof value !== 'string' || !CUSTOM_FIELD_SCOPE_RE.test(value.trim())) {
    throw badRequest(`${key} must be a short identifier (letters, digits, - or _, max 64)`, traceId);
  }
  return value.trim();
}

function parseCode(value: unknown, traceId: string): string {
  if (typeof value !== 'string' || !CUSTOM_FIELD_CODE_RE.test(value.trim())) {
    throw badRequest('code must be a camelCase/snake_case identifier (max 64)', traceId);
  }
  return value.trim();
}

function parseType(value: unknown, traceId: string): CustomFieldType {
  if (typeof value === 'string' && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value)) {
    return value as CustomFieldType;
  }
  throw badRequest(
    `type must be one of ${(CUSTOM_FIELD_TYPES as readonly string[]).join(', ')}`,
    traceId,
  );
}

function parseStatus(value: unknown, traceId: string): CustomFieldStatus {
  if (typeof value === 'string' && (CUSTOM_FIELD_STATUSES as readonly string[]).includes(value)) {
    return value as CustomFieldStatus;
  }
  throw badRequest(
    `status must be one of ${(CUSTOM_FIELD_STATUSES as readonly string[]).join(', ')}`,
    traceId,
  );
}

function parseRequired(value: unknown, traceId: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw badRequest('required must be a boolean', traceId);
}

/** Validates the create body; mirrors `customFieldCreateInputSchema` (contracts). */
export function parseCustomFieldCreateInput(body: unknown, traceId: string): CustomFieldCreateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with module, entity, code and type', traceId);
  }
  const record = body as Record<string, unknown>;
  return {
    module: parseScope(record.module, 'module', traceId),
    entity: parseScope(record.entity, 'entity', traceId),
    code: parseCode(record.code, traceId),
    type: parseType(record.type, traceId),
    required: parseRequired(record.required, traceId),
    status: record.status === undefined ? 'draft' : parseStatus(record.status, traceId),
  };
}

/** Validates the update body; mirrors `customFieldUpdateInputSchema` (contracts). */
export function parseCustomFieldUpdateInput(body: unknown, traceId: string): CustomFieldUpdateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with type, required or status', traceId);
  }
  const record = body as Record<string, unknown>;
  const hasType = record.type !== undefined;
  const hasRequired = record.required !== undefined;
  const hasStatus = record.status !== undefined;
  if (!hasType && !hasRequired && !hasStatus) {
    throw badRequest('Body must include at least one of type, required or status', traceId);
  }
  if (hasRequired && typeof record.required !== 'boolean') {
    throw badRequest('required must be a boolean', traceId);
  }
  return {
    type: hasType ? parseType(record.type, traceId) : undefined,
    required: hasRequired ? (record.required as boolean) : undefined,
    status: hasStatus ? parseStatus(record.status, traceId) : undefined,
  };
}

/**
 * Parses the query of `GET /v1/custom-fields`. Every filter is optional; an
 * unknown `status` or a malformed scope is a 400, never a silently unfiltered
 * list.
 */
export function parseCustomFieldQuery(
  query: unknown,
  traceId: string,
): { module: string | null; entity: string | null; status: CustomFieldStatus | null } {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const readFilter = (key: string): string | null => {
    const raw = record[key];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') throw badRequest(`${key} must be a string`, traceId);
    return raw.trim();
  };
  const module = readFilter('module');
  const entity = readFilter('entity');
  const statusRaw = readFilter('status');
  if (module !== null && !CUSTOM_FIELD_SCOPE_RE.test(module)) {
    throw badRequest('module must be a short identifier (letters, digits, - or _, max 64)', traceId);
  }
  if (entity !== null && !CUSTOM_FIELD_SCOPE_RE.test(entity)) {
    throw badRequest('entity must be a short identifier (letters, digits, - or _, max 64)', traceId);
  }
  const status = statusRaw === null ? null : parseStatus(statusRaw, traceId);
  return { module, entity, status };
}

function requireUuidParam(value: string, traceId: string): string {
  const trimmed = value?.trim() ?? '';
  if (!UUID_RE.test(trimmed)) throw badRequest('Invalid custom field id', traceId);
  return trimmed;
}

// ============ management use cases ============

/**
 * `POST /v1/custom-fields` — declares one typed key. `module`/`entity`/`code`
 * are the unique key per tenant: a duplicate answers 409 `duplicate`.
 */
export async function createCustomField(
  actor: CustomFieldActor,
  body: unknown,
): Promise<CustomFieldDef> {
  const input = parseCustomFieldCreateInput(body, actor.traceId);
  const membership = await authorizeAdmin(actor, 'custom_field.create');
  let result: unknown;
  try {
    result = await actor.client.query(INSERT_DEF_SQL, [
      actor.tenantId,
      input.module,
      input.entity,
      input.code,
      input.type,
      input.required,
      input.status,
    ]);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === '23505'
    ) {
      throw duplicate(actor.traceId);
    }
    throw error;
  }
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      {
        code: 'write.failed',
        message: 'Custom field insert returned no row',
        traceId: actor.traceId,
      },
      500,
    );
  }
  const def = mapCustomFieldRow(row);
  await writeAudit(actor, membership, 'custom_field.created', def.id, {
    module: def.module,
    entity: def.entity,
    code: def.code,
    type: def.type,
  });
  return def;
}

/** `GET /v1/custom-fields` — tenant definitions, optionally narrowed. */
export async function listCustomFields(
  actor: CustomFieldActor,
  query: unknown,
): Promise<CustomFieldDef[]> {
  const filters = parseCustomFieldQuery(query, actor.traceId);
  await authorizeAdmin(actor, 'custom_field.list');
  if (filters.module !== null && filters.entity !== null && filters.status === null) {
    const result = await actor.client.query(LIST_DEFS_FILTERED_SQL, [
      actor.tenantId,
      filters.module,
      filters.entity,
    ]);
    return readRows(result).map(mapCustomFieldRow);
  }
  const result = await actor.client.query(LIST_DEFS_SQL, [actor.tenantId]);
  return readRows(result)
    .map(mapCustomFieldRow)
    .filter(
      (def) =>
        (filters.module === null || def.module === filters.module) &&
        (filters.entity === null || def.entity === filters.entity) &&
        (filters.status === null || def.status === filters.status),
    );
}

/** `GET /v1/custom-fields/:id` — one definition of the tenant. */
export async function getCustomField(actor: CustomFieldActor, id: string): Promise<CustomFieldDef> {
  const defId = requireUuidParam(id, actor.traceId);
  await authorizeAdmin(actor, 'custom_field.open');
  const result = await actor.client.query(SELECT_DEF_SQL, [actor.tenantId, defId]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  return mapCustomFieldRow(row);
}

/**
 * `PATCH /v1/custom-fields/:id` — retargets `type`/`required`/`status`.
 * `module`/`entity`/`code` are immutable (they are the unique key): a rename
 * is retire + create. Unknown ids answer 404.
 */
export async function updateCustomField(
  actor: CustomFieldActor,
  id: string,
  body: unknown,
): Promise<CustomFieldDef> {
  const defId = requireUuidParam(id, actor.traceId);
  const input = parseCustomFieldUpdateInput(body, actor.traceId);
  const membership = await authorizeAdmin(actor, 'custom_field.update');
  const result = await actor.client.query(UPDATE_DEF_SQL, [
    defId,
    actor.tenantId,
    input.type ?? null,
    input.required ?? null,
    input.status ?? null,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  const def = mapCustomFieldRow(row);
  await writeAudit(actor, membership, 'custom_field.updated', def.id, {
    module: def.module,
    entity: def.entity,
    code: def.code,
    type: def.type,
    required: def.required,
    status: def.status,
  });
  return def;
}

// ============ write-time enforcement ============

/**
 * Loads the `active` definitions typing one `(module, entity)` pair. Called
 * without the admin gate: the caller's own vertical guard already ran, and
 * these rows are read-only shaping of that same write.
 */
export async function loadActiveDefs(
  client: CustomFieldClient,
  tenantId: string,
  module: string,
  entity: string,
): Promise<CustomFieldDef[]> {
  const result = await client.query(LIST_ACTIVE_DEFS_SQL, [tenantId, module, entity]);
  return readRows(result).map(mapCustomFieldRow);
}

function isMissing(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

/** `true` for a `YYYY-MM-DD` string naming a real calendar day. */
function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function valueMatchesType(value: unknown, type: CustomFieldType): boolean {
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return typeof value === 'string' && isRealDate(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

/**
 * Enforces `active` definitions over one JSONB bag (`contacts` or `values`):
 * every `required` code must be present and non-blank, and every present code
 * must match its declared `type`. Unknown keys pass through — the bag keeps
 * its built-in keys (`phone`, vital signs) alongside the custom ones.
 */
export function validateCustomValues(
  defs: readonly CustomFieldDef[],
  values: Record<string, unknown>,
  traceId: string,
): void {
  for (const def of defs) {
    const value = values[def.code];
    if (isMissing(value)) {
      if (def.required) {
        throw badRequest(`Missing required custom field: ${def.code}`, traceId);
      }
      continue;
    }
    if (!valueMatchesType(value, def.type)) {
      throw badRequest(
        `Custom field "${def.code}" must be a ${def.type}`,
        traceId,
      );
    }
  }
}
