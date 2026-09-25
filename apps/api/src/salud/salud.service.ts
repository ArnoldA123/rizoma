// Salud domain service — patients, episodes and appointments
// (bases-consolidadas-v1.md §2.3, §3.1, §3.3, §4.4).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controllers stay thin. The
// service owns the whole request use case:
//   1. build the guard facts (membership, org-node subtree, tenant module);
//   2. evaluate the single central rule through `canActivate` — which audits
//      every denial as `access.denied` — and refuse on denial;
//   3. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every write, append one `audit_log` row.
// Nothing here reads the environment, the clock is Postgres', and every query
// carries `tenant_id` explicitly so isolation holds even where the connection
// role can bypass RLS.
//
// Field model: request/response use camelCase; the tables use snake_case. The
// scope rule is `entity.org_node_id ∈ subtree(membership.org_node_id)`; the
// list endpoints enforce it in SQL and the by-id endpoints load the entity and
// hand its own org node to the guard, so an out-of-scope row is denied (and
// audited) instead of silently returned.
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import { NOTIFY_TEMPLATE_APPOINTMENT_SCHEDULED, tryEnqueueNotify } from '../notify/notify.service.ts';
import type { HeaderRecord, TenantScopedRequest } from '../tenant/tenant.middleware.ts';

/** Tenant module this vertical requires (§3.1 property 6 / §3.5). */
export const SALUD_MODULE = 'salud';

/** Rows the list endpoints return at most; keeps a stray wide scan bounded. */
export const SALUD_LIST_LIMIT = 200;

/** Timestamped value (`timestamptz`/`date`) normalized to a plain string. */
type IsoValue = string | null;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface SaludClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Everything a use case needs from the request, framework-free. */
export interface ActorContext {
  readonly client: SaludClient;
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

/** 404 envelope for an entity that does not exist in the tenant. */
function notFound(entity: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'not_found', message: `${entity} not found`, traceId },
    404,
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
 * bound (`req.tenant` + `req.tenantClient`). The JWT path only exposes the
 * resolved tenant context, so `roles` stays empty here: the guard's role term
 * is computed from `memberships.role`, and the JWT roles only feed the denial
 * audit diff.
 */
export function actorFromRequest(req: TenantScopedRequest): ActorContext {
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

/** Descendants of the membership node, inclusive (§3.1 property 3). */
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

/** Loads membership, subtree and module activation in the request client. */
async function loadFacts(actor: ActorContext, module: string = SALUD_MODULE): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await tenantHasModule(actor.client, actor.tenantId, module);
  return { membership, scopeSubtree, moduleActive };
}

interface AuthorizeOptions {
  readonly action: ActionCode;
  /** Audit entity kind, e.g. `patient_file`. */
  readonly entity: string;
  readonly entityId?: string | null;
  /**
   * Scope term of the rule: the entity's own node, or the membership node for
   * the list reads (which have no single target row). When the caller has no
   * membership the list reads use the tenant id as a deny-by-default
   * placeholder; that value is never audited, see `authorize`.
   */
  readonly orgNodeId: string;
  readonly stateAllows?: boolean;
  readonly attemptedAction?: string;
}

/**
 * Runs the single central rule and audits a denial. Returns the membership on
 * allow; throws a 403 envelope on deny (the denial row is already written by
 * `canActivate`, inside the same request transaction).
 */
async function authorize(
  actor: ActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions,
): Promise<MembershipRecord> {
  const rolePermits =
    facts.membership !== null && rolePermitsAction(facts.membership.role, options.action);
  // `audit_log.org_node_id` is a FK to `org_nodes` and the tenant id is not a
  // node id: recording the list-read placeholder there made the denial insert
  // raise SQLSTATE 23503, which aborted the request transaction and surfaced as
  // an untyped 500 instead of the typed 403 (MVP1 W2F). Without a membership
  // the caller has no org context at all, so the audit row records NULL; the
  // scope term above is untouched and the decision still denies.
  const auditOrgNodeId = facts.membership === null ? null : options.orgNodeId;
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
      orgNodeId: auditOrgNodeId,
      attemptedAction: options.attemptedAction ?? options.action,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ write audit ============

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

interface AuditEntry {
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly orgNodeId: string;
  readonly diff: Record<string, unknown>;
}

/** Appends one row per successful write (§4.4); the correlation id rides in `diff`. */
async function writeAudit(
  actor: ActorContext,
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
 * 4xx envelopes: a duplicate business key as 409 and a dangling reference as
 * 400. Any other failure keeps propagating to the 500 path.
 */
async function runInsert(
  actor: ActorContext,
  duplicateMessage: string,
  run: () => Promise<unknown>,
): Promise<readonly Record<string, unknown>[]> {
  try {
    return readRows(await run());
  } catch (error) {
    const state = sqlState(error);
    if (state === SQLSTATE_UNIQUE_VIOLATION) {
      throw new HttpException({ code: 'duplicate', message: duplicateMessage, traceId: actor.traceId }, 409);
    }
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** `timestamptz`/`date` may arrive as `Date` or string; normalize or null. */
function toIso(value: unknown): IsoValue {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** `date`-only column normalized to `YYYY-MM-DD`. */
function toDateOnly(value: unknown): IsoValue {
  const iso = toIso(value);
  return iso === null ? null : iso.slice(0, 10);
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DNI_RE = /^\d{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ============ validation ============

const DOCUMENT_TYPES = ['dni', 'ce', 'pasaporte'] as const;
type DocumentType = (typeof DOCUMENT_TYPES)[number];

const PATIENT_UPDATE_FIELDS = ['personName', 'birthdate', 'allergies', 'alerts', 'contacts', 'active'] as const;

function requireString(
  body: Record<string, unknown>,
  key: string,
  traceId: string,
): string {
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

interface PatientCreateInput {
  readonly orgNodeId: string;
  readonly personName: string;
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly birthdate: IsoValue;
  readonly allergies: string[];
  readonly alerts: string[];
  readonly contacts: Record<string, unknown>;
}

function parsePatientCreate(body: unknown, traceId: string): PatientCreateInput {
  const record = asRecord(body);
  const documentType = requireString(record, 'documentType', traceId);
  if (!(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw badRequest(`Invalid documentType (expected dni|ce|pasaporte): ${documentType}`, traceId);
  }
  const documentNumber = requireString(record, 'documentNumber', traceId);
  if (documentType === 'dni' && !DNI_RE.test(documentNumber)) {
    throw badRequest('A DNI documentNumber must be exactly 8 digits', traceId);
  }
  let birthdate: IsoValue = null;
  if (record.birthdate !== undefined && record.birthdate !== null) {
    const raw = requireString(record, 'birthdate', traceId);
    if (!DATE_RE.test(raw)) throw badRequest('birthdate must be YYYY-MM-DD', traceId);
    birthdate = raw;
  }
  return {
    orgNodeId: requireUuid(record, 'orgNodeId', traceId),
    personName: requireString(record, 'personName', traceId),
    documentType: documentType as DocumentType,
    documentNumber,
    birthdate,
    allergies: readStringArray(record.allergies),
    alerts: readStringArray(record.alerts),
    contacts: readJsonObject(record.contacts),
  };
}

interface EpisodeCreateInput {
  readonly patientId: string;
  readonly specialty: string;
  readonly professionalId: string;
}

function parseEpisodeCreate(
  body: unknown,
  traceId: string,
  fallbackProfessionalId: string,
): EpisodeCreateInput {
  const record = asRecord(body);
  return {
    patientId: requireUuid(record, 'patientId', traceId),
    specialty: requireString(record, 'specialty', traceId),
    professionalId: optionalUuid(record, 'professionalId', traceId) ?? fallbackProfessionalId,
  };
}

interface AppointmentCreateInput {
  readonly orgNodeId: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly startsAt: string;
  readonly durationMin: number;
}

function parseAppointmentCreate(
  body: unknown,
  traceId: string,
): AppointmentCreateInput {
  const record = asRecord(body);
  const startsAt = requireString(record, 'startsAt', traceId);
  if (Number.isNaN(Date.parse(startsAt))) throw badRequest('startsAt must be an ISO datetime', traceId);
  const durationMin = record.durationMin;
  if (typeof durationMin !== 'number' || !Number.isInteger(durationMin) || durationMin <= 0) {
    throw badRequest('durationMin must be a positive integer', traceId);
  }
  return {
    orgNodeId: requireUuid(record, 'orgNodeId', traceId),
    patientId: requireUuid(record, 'patientId', traceId),
    professionalId: requireUuid(record, 'professionalId', traceId),
    startsAt,
    durationMin,
  };
}

// ============ row shapes ============

export interface PatientRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  personName: string;
  documentType: string;
  documentNumber: string;
  birthdate: IsoValue;
  allergies: string[];
  alerts: string[];
  contacts: Record<string, unknown>;
  active: boolean;
  createdAt: IsoValue;
}

export interface EpisodeRecord {
  id: string;
  tenantId: string;
  patientId: string;
  specialty: string;
  professionalId: string;
  openedAt: IsoValue;
  closedAt: IsoValue;
  status: string;
}

export interface AppointmentRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  patientId: string;
  professionalId: string;
  startsAt: IsoValue;
  durationMin: number;
  status: string;
  createdAt: IsoValue;
}

const PATIENT_COLUMNS =
  'id, tenant_id, org_node_id, person_name, document_type, document_number, birthdate, allergies, alerts, contacts, active, created_at';
const PATIENT_RETURNING = `RETURNING ${PATIENT_COLUMNS}`;

function mapPatient(row: Record<string, unknown>): PatientRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    personName: readString(row.person_name) ?? '',
    documentType: readString(row.document_type) ?? '',
    documentNumber: readString(row.document_number) ?? '',
    birthdate: toDateOnly(row.birthdate),
    allergies: readStringArray(row.allergies),
    alerts: readStringArray(row.alerts),
    contacts: readJsonObject(row.contacts),
    active: readBoolean(row.active),
    createdAt: toIso(row.created_at),
  };
}

function mapEpisode(row: Record<string, unknown>): EpisodeRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    patientId: readString(row.patient_id) ?? '',
    specialty: readString(row.specialty) ?? '',
    professionalId: readString(row.professional_id) ?? '',
    openedAt: toIso(row.opened_at),
    closedAt: toIso(row.closed_at),
    status: readString(row.status) ?? '',
  };
}

function mapAppointment(row: Record<string, unknown>): AppointmentRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    patientId: readString(row.patient_id) ?? '',
    professionalId: readString(row.professional_id) ?? '',
    startsAt: toIso(row.starts_at),
    durationMin: typeof row.duration_min === 'number' ? row.duration_min : Number(row.duration_min),
    status: readString(row.status) ?? '',
    createdAt: toIso(row.created_at),
  };
}

// ============ shared SQL ============

const SELECT_PATIENT_SQL = `SELECT ${PATIENT_COLUMNS}
FROM patient_files WHERE tenant_id = $1 AND id = $2`;
const LIST_PATIENTS_SQL = `SELECT ${PATIENT_COLUMNS}
FROM patient_files WHERE tenant_id = $1 AND org_node_id = ANY($2::uuid[])
ORDER BY created_at DESC LIMIT ${SALUD_LIST_LIMIT}`;
const INSERT_PATIENT_SQL = `INSERT INTO patient_files
  (tenant_id, org_node_id, person_name, document_type, document_number, birthdate, allergies, alerts, contacts, active)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
${PATIENT_RETURNING}`;
const UPDATE_PATIENT_SQL = `UPDATE patient_files
SET person_name = $3, birthdate = $4, allergies = $5, alerts = $6, contacts = $7, active = $8
WHERE tenant_id = $1 AND id = $2
${PATIENT_RETURNING}`;

const EPISODE_COLUMNS =
  'e.id, e.tenant_id, e.patient_id, e.specialty, e.professional_id, e.opened_at, e.closed_at, e.status';
const SELECT_EPISODE_SQL = `SELECT ${EPISODE_COLUMNS}, p.org_node_id
FROM episodes e
JOIN patient_files p ON p.id = e.patient_id AND p.tenant_id = e.tenant_id
WHERE e.tenant_id = $1 AND e.id = $2`;
const LIST_EPISODES_SQL = `SELECT ${EPISODE_COLUMNS}
FROM episodes e
JOIN patient_files p ON p.id = e.patient_id AND p.tenant_id = e.tenant_id
WHERE e.tenant_id = $1 AND p.org_node_id = ANY($2::uuid[])
ORDER BY e.opened_at DESC LIMIT ${SALUD_LIST_LIMIT}`;
const INSERT_EPISODE_SQL = `INSERT INTO episodes
  (tenant_id, patient_id, specialty, professional_id, status)
VALUES ($1, $2, $3, $4, 'open')
RETURNING id, tenant_id, patient_id, specialty, professional_id, opened_at, closed_at, status`;
const CLOSE_EPISODE_SQL = `UPDATE episodes
SET status = 'closed', closed_at = now()
WHERE tenant_id = $1 AND id = $2
RETURNING id, tenant_id, patient_id, specialty, professional_id, opened_at, closed_at, status`;

const APPOINTMENT_COLUMNS =
  'id, tenant_id, org_node_id, patient_id, professional_id, starts_at, duration_min, status, created_at';
const SELECT_APPOINTMENT_SQL = `SELECT ${APPOINTMENT_COLUMNS}
FROM appointments WHERE tenant_id = $1 AND id = $2`;
const LIST_APPOINTMENTS_SQL = `SELECT ${APPOINTMENT_COLUMNS}
FROM appointments WHERE tenant_id = $1 AND org_node_id = ANY($2::uuid[])
ORDER BY starts_at DESC LIMIT ${SALUD_LIST_LIMIT}`;
const INSERT_APPOINTMENT_SQL = `INSERT INTO appointments
  (tenant_id, org_node_id, patient_id, professional_id, starts_at, duration_min, status)
VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
RETURNING ${APPOINTMENT_COLUMNS}`;

/** Loads a patient within the tenant; null means invisible/nonexistent. */
async function findPatient(
  actor: ActorContext,
  patientId: string,
): Promise<PatientRecord | null> {
  const result = await actor.client.query(SELECT_PATIENT_SQL, [actor.tenantId, patientId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapPatient(row);
}

// ============ patients ============

/** `patient_file` list inside the membership subtree. */
export async function listPatients(actor: ActorContext): Promise<PatientRecord[]> {
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'patient.read',
    entity: 'patient_file',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
  });
  const result = await actor.client.query(LIST_PATIENTS_SQL, [actor.tenantId, [...facts.scopeSubtree]]);
  return readRows(result).map(mapPatient);
}

/** Registers a patient file; requires `patient.write` over the target sede. */
export async function createPatient(actor: ActorContext, body: unknown): Promise<PatientRecord> {
  const input = parsePatientCreate(body, actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'patient.write',
    entity: 'patient_file',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'patient.create',
  });
  const rows = await runInsert(actor, 'A patient with that document already exists', () =>
    actor.client.query(INSERT_PATIENT_SQL, [
      actor.tenantId,
      input.orgNodeId,
      input.personName,
      input.documentType,
      input.documentNumber,
      input.birthdate,
      input.allergies,
      input.alerts,
      JSON.stringify(input.contacts),
    ]),
  );
  const row = rows[0];
  if (row === undefined) throw new HttpException({ code: 'write.failed', message: 'Patient insert returned no row', traceId: actor.traceId }, 500);
  const patient = mapPatient(row);
  await writeAudit(actor, membership, {
    action: 'patient.created',
    entity: 'patient_file',
    entityId: patient.id,
    orgNodeId: patient.orgNodeId,
    diff: { documentType: patient.documentType, orgNodeId: patient.orgNodeId },
  });
  return patient;
}

/** Opens one patient file; the row's own org node drives the scope check. */
export async function getPatient(actor: ActorContext, patientId: string): Promise<PatientRecord> {
  if (!UUID_RE.test(patientId)) throw badRequest('Invalid patient id', actor.traceId);
  const patient = await findPatient(actor, patientId);
  if (patient === null) throw notFound('patient_file', actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'patient.read',
    entity: 'patient_file',
    entityId: patient.id,
    orgNodeId: patient.orgNodeId,
    attemptedAction: 'patient.open',
  });
  return patient;
}

/** Edits the patient file; an inactive file is closed to writes (§3.1 p.4). */
export async function updatePatient(
  actor: ActorContext,
  patientId: string,
  body: unknown,
): Promise<PatientRecord> {
  if (!UUID_RE.test(patientId)) throw badRequest('Invalid patient id', actor.traceId);
  const current = await findPatient(actor, patientId);
  if (current === null) throw notFound('patient_file', actor.traceId);
  const record = asRecord(body);
  for (const key of Object.keys(record)) {
    if (!(PATIENT_UPDATE_FIELDS as readonly string[]).includes(key)) {
      throw badRequest(`Unknown patient field: ${key}`, actor.traceId);
    }
  }
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'patient.write',
    entity: 'patient_file',
    entityId: current.id,
    orgNodeId: current.orgNodeId,
    stateAllows: current.active,
    attemptedAction: 'patient.update',
  });
  const personName =
    record.personName === undefined ? current.personName : requireString(record, 'personName', actor.traceId);
  let birthdate = current.birthdate;
  if (record.birthdate !== undefined && record.birthdate !== null) {
    const raw = requireString(record, 'birthdate', actor.traceId);
    if (!DATE_RE.test(raw)) throw badRequest('birthdate must be YYYY-MM-DD', actor.traceId);
    birthdate = raw;
  }
  const allergies =
    record.allergies === undefined ? current.allergies : readStringArray(record.allergies);
  const alerts = record.alerts === undefined ? current.alerts : readStringArray(record.alerts);
  const contacts =
    record.contacts === undefined ? current.contacts : readJsonObject(record.contacts);
  const active = record.active === undefined ? current.active : record.active === true;
  const result = await actor.client.query(UPDATE_PATIENT_SQL, [
    actor.tenantId,
    current.id,
    personName,
    birthdate,
    allergies,
    alerts,
    JSON.stringify(contacts),
    active,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) throw new HttpException({ code: 'write.failed', message: 'Patient update returned no row', traceId: actor.traceId }, 500);
  const patient = mapPatient(row);
  await writeAudit(actor, membership, {
    action: 'patient.updated',
    entity: 'patient_file',
    entityId: patient.id,
    orgNodeId: patient.orgNodeId,
    diff: { changed: Object.keys(record) },
  });
  return patient;
}

// ============ episodes ============

/** Episode list scoped through its patient's sede. */
export async function listEpisodes(actor: ActorContext): Promise<EpisodeRecord[]> {
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'patient.read',
    entity: 'episode',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'episode.list',
  });
  const result = await actor.client.query(LIST_EPISODES_SQL, [actor.tenantId, [...facts.scopeSubtree]]);
  return readRows(result).map(mapEpisode);
}

/** Opens an episode for an active patient the actor can reach. */
export async function createEpisode(actor: ActorContext, body: unknown): Promise<EpisodeRecord> {
  const input = parseEpisodeCreate(body, actor.traceId, actor.userId);
  const patient = await findPatient(actor, input.patientId);
  if (patient === null) throw notFound('patient_file', actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'episode.write',
    entity: 'episode',
    orgNodeId: patient.orgNodeId,
    stateAllows: patient.active,
    attemptedAction: 'episode.create',
  });
  const rows = await runInsert(actor, 'Episode already exists', () =>
    actor.client.query(INSERT_EPISODE_SQL, [
      actor.tenantId,
      patient.id,
      input.specialty,
      input.professionalId,
    ]),
  );
  const row = rows[0];
  if (row === undefined) throw new HttpException({ code: 'write.failed', message: 'Episode insert returned no row', traceId: actor.traceId }, 500);
  const episode = mapEpisode(row);
  await writeAudit(actor, membership, {
    action: 'episode.created',
    entity: 'episode',
    entityId: episode.id,
    orgNodeId: patient.orgNodeId,
    diff: { patientId: patient.id, specialty: episode.specialty },
  });
  return episode;
}

/** Reads one episode through its patient's sede. */
export async function getEpisode(actor: ActorContext, episodeId: string): Promise<EpisodeRecord> {
  if (!UUID_RE.test(episodeId)) throw badRequest('Invalid episode id', actor.traceId);
  const result = await actor.client.query(SELECT_EPISODE_SQL, [actor.tenantId, episodeId]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound('episode', actor.traceId);
  const orgNodeId = readString(row.org_node_id) ?? '';
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'patient.read',
    entity: 'episode',
    entityId: episodeId,
    orgNodeId,
    attemptedAction: 'episode.open',
  });
  return mapEpisode(row);
}

/** Closes an open episode; a closed/cancelled one is closed to writes. */
export async function closeEpisode(actor: ActorContext, episodeId: string): Promise<EpisodeRecord> {
  if (!UUID_RE.test(episodeId)) throw badRequest('Invalid episode id', actor.traceId);
  const current = await actor.client.query(SELECT_EPISODE_SQL, [actor.tenantId, episodeId]);
  const row = readRows(current)[0];
  if (row === undefined) throw notFound('episode', actor.traceId);
  const orgNodeId = readString(row.org_node_id) ?? '';
  const status = readString(row.status) ?? '';
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'episode.write',
    entity: 'episode',
    entityId: episodeId,
    orgNodeId,
    stateAllows: status === 'open',
    attemptedAction: 'episode.close',
  });
  const result = await actor.client.query(CLOSE_EPISODE_SQL, [actor.tenantId, episodeId]);
  const closed = readRows(result)[0];
  if (closed === undefined) throw new HttpException({ code: 'write.failed', message: 'Episode close returned no row', traceId: actor.traceId }, 500);
  const episode = mapEpisode(closed);
  await writeAudit(actor, membership, {
    action: 'episode.closed',
    entity: 'episode',
    entityId: episode.id,
    orgNodeId,
    diff: { from: 'open', to: 'closed' },
  });
  return episode;
}

// ============ appointments ============

/** Appointment agenda scoped to the membership subtree. */
export async function listAppointments(actor: ActorContext): Promise<AppointmentRecord[]> {
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'agenda.read',
    entity: 'appointment',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'appointment.list',
  });
  const result = await actor.client.query(LIST_APPOINTMENTS_SQL, [actor.tenantId, [...facts.scopeSubtree]]);
  return readRows(result).map(mapAppointment);
}

/** Schedules an appointment at a sede the actor can write to. */
export async function createAppointment(
  actor: ActorContext,
  body: unknown,
): Promise<AppointmentRecord> {
  const input = parseAppointmentCreate(body, actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'appointment.write',
    entity: 'appointment',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'appointment.create',
  });
  const rows = await runInsert(actor, 'Appointment already exists', () =>
    actor.client.query(INSERT_APPOINTMENT_SQL, [
      actor.tenantId,
      input.orgNodeId,
      input.patientId,
      input.professionalId,
      input.startsAt,
      input.durationMin,
    ]),
  );
  const row = rows[0];
  if (row === undefined) throw new HttpException({ code: 'write.failed', message: 'Appointment insert returned no row', traceId: actor.traceId }, 500);
  const appointment = mapAppointment(row);
  await writeAudit(actor, membership, {
    action: 'appointment.created',
    entity: 'appointment',
    entityId: appointment.id,
    orgNodeId: appointment.orgNodeId,
    diff: { patientId: appointment.patientId, startsAt: appointment.startsAt },
  });
  // Best-effort `appointment.scheduled` notice, same transaction: the channel
  // follows the contact data on file (email first, sms fallback); a patient
  // without either address — or without an active template — skips silently.
  await tryNotifyAppointmentScheduled(actor, appointment);
  return appointment;
}

/** First non-blank string under any of the contact keys, or null. */
function readContactAddress(contacts: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = contacts[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Enqueues the `appointment.scheduled` notice in the creation transaction
 * (same `client`, no BEGIN/COMMIT): the `queued` row commits or rolls back
 * with the appointment. Never throws — every skip or enqueue failure
 * resolves silently so scheduling never breaks.
 */
async function tryNotifyAppointmentScheduled(
  actor: ActorContext,
  appointment: AppointmentRecord,
): Promise<void> {
  try {
    const patient = await findPatient(actor, appointment.patientId);
    if (patient === null) return;
    const email = readContactAddress(patient.contacts, ['email']);
    const phone = readContactAddress(patient.contacts, ['phone']);
    const channel = email !== null ? 'email' : phone !== null ? 'sms' : null;
    const to = email ?? phone;
    if (channel === null || to === null) return;
    await tryEnqueueNotify(actor.client, actor.tenantId, {
      channel,
      template: NOTIFY_TEMPLATE_APPOINTMENT_SCHEDULED,
      to,
      payload: {
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        startsAt: appointment.startsAt,
        durationMin: appointment.durationMin,
      },
    });
  } catch {
    // Best-effort: scheduling owns the transaction, the notice never blocks it.
  }
}

/** Reads one appointment; its own sede drives the scope check. */
export async function getAppointment(
  actor: ActorContext,
  appointmentId: string,
): Promise<AppointmentRecord> {
  if (!UUID_RE.test(appointmentId)) throw badRequest('Invalid appointment id', actor.traceId);
  const result = await actor.client.query(SELECT_APPOINTMENT_SQL, [actor.tenantId, appointmentId]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound('appointment', actor.traceId);
  const appointment = mapAppointment(row);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'agenda.read',
    entity: 'appointment',
    entityId: appointment.id,
    orgNodeId: appointment.orgNodeId,
    attemptedAction: 'appointment.open',
  });
  return appointment;
}
