// Triage service — insert-only vital signs (bases-consolidadas-v1.md §2.3).
//
// Migration 003 declares `triages` with no state machine: a correction is a new
// row, never an UPDATE or DELETE, so this module exposes only the history read
// and the record write. Deliberately plain like `salud.service.ts` — no
// decorators, so it stays loadable under strip-only TypeScript — with the same
// split: the thin `triages.controller.ts` owns HTTP, this module owns
// validation, the guard, the sede scope and the write audit.
//
// Scope rule: `triages` carries no `org_node_id`; the scope travels through the
// patient's own sede (`patient.org_node_id ∈ subtree(membership.org_node_id)`).
// Reads need `patient.read`, writes need `patient.write` over that sede, and an
// inactive file is closed to writes (§3.1 property 4).
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import {
  CUSTOM_FIELD_ENTITY_TRIAGE,
  CUSTOM_FIELD_MODULE_SALUD,
  loadActiveDefs,
  validateCustomValues,
} from '../custom-fields/custom-fields.service.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

/** Tenant module this vertical requires (bases §3.1 property 6 / §3.5). */
export const SALUD_MODULE = 'salud';

/** Rows the history read returns at most; keeps a stray wide scan bounded. */
export const TRIAGE_LIST_LIMIT = 200;

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

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface QueryResultLike {
  readonly rows?: unknown;
}

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as QueryResultLike | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `jsonb` arrives as an object from `pg`; tolerate a stored string payload. */
function readJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/** `timestamptz` may arrive as `Date` or string; normalize or null. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function requireString(body: Record<string, unknown>, key: string, traceId: string): string {
  const value = readString(body[key])?.trim();
  if (value === undefined || value === '') {
    throw badRequest(`Missing required field: ${key}`, traceId);
  }
  return value;
}

function requireUuid(body: Record<string, unknown>, key: string, traceId: string): string {
  const value = requireString(body, key, traceId);
  if (!UUID_RE.test(value)) throw badRequest(`Invalid UUID in field: ${key}`, traceId);
  return value;
}

function requireUuidParam(value: string, label: string, traceId: string): string {
  if (!UUID_RE.test(value)) throw badRequest(`Invalid ${label}`, traceId);
  return value;
}

// ============ validation ============

interface TriageCreateInput {
  readonly patientId: string;
  readonly episodeId: string | null;
  readonly values: Record<string, unknown>;
  readonly at: string | null;
}

function parseTriageCreate(body: unknown, traceId: string): TriageCreateInput {
  const record = asRecord(body);
  const values = readJsonObject(record.values);
  if (Object.keys(values).length === 0) {
    throw badRequest('values must carry at least one vital sign', traceId);
  }
  let at: string | null = null;
  if (record.at !== undefined && record.at !== null) {
    const raw = requireString(record, 'at', traceId);
    if (Number.isNaN(Date.parse(raw))) throw badRequest('at must be an ISO datetime', traceId);
    at = raw;
  }
  let episodeId: string | null = null;
  if (record.episodeId !== undefined && record.episodeId !== null) {
    episodeId = requireUuid(record, 'episodeId', traceId);
  }
  return { patientId: requireUuid(record, 'patientId', traceId), episodeId, values, at };
}

// ============ row shape ============

/** One triage row as the API exposes it. */
export interface TriageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly patientId: string;
  /** Nullable: a triage may precede the first episode of the patient. */
  readonly episodeId: string | null;
  readonly recordedBy: string;
  readonly values: Record<string, unknown>;
  readonly at: string | null;
}

const TRIAGE_COLUMNS = 'id, tenant_id, patient_id, episode_id, recorded_by, values, at';

function mapTriage(row: Record<string, unknown>): TriageRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    patientId: readString(row.patient_id) ?? '',
    episodeId: readString(row.episode_id) ?? null,
    recordedBy: readString(row.recorded_by) ?? '',
    values: readJsonObject(row.values),
    at: toIso(row.at),
  };
}

// ============ guard facts and audit ============

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

/** Descendants of the membership node, inclusive (bases §3.1 property 3). */
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

async function loadFacts(actor: ActorContext): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await tenantHasModule(actor.client, actor.tenantId, SALUD_MODULE);
  return { membership, scopeSubtree, moduleActive };
}

interface AuthorizeOptions {
  readonly action: ActionCode;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly stateAllows?: boolean;
  readonly attemptedAction?: string;
}

/** Runs the central rule and audits any denial before throwing 403. */
async function authorize(
  actor: ActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions,
): Promise<MembershipRecord> {
  const rolePermits =
    facts.membership !== null && rolePermitsAction(facts.membership.role, options.action);
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
      entity: 'triage',
      entityId: options.entityId ?? null,
      orgNodeId: auditOrgNodeId,
      attemptedAction: options.attemptedAction ?? options.action,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

/** Appends one row per successful write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: ActorContext,
  membership: MembershipRecord,
  entry: { action: string; entityId: string; orgNodeId: string; diff: Record<string, unknown> },
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    entry.action,
    'triage',
    entry.entityId,
    entry.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...entry.diff }),
    actor.ip,
  ]);
}

// ============ row I/O ============

interface PatientScope {
  readonly id: string;
  readonly orgNodeId: string;
  readonly active: boolean;
}

const SELECT_PATIENT_SQL =
  'SELECT id, tenant_id, org_node_id, active FROM patient_files WHERE tenant_id = $1 AND id = $2';

async function findPatientScope(
  actor: ActorContext,
  patientId: string,
): Promise<PatientScope | null> {
  const result = await actor.client.query(SELECT_PATIENT_SQL, [actor.tenantId, patientId]);
  const row = readRows(result)[0];
  if (row === undefined) return null;
  const id = readString(row.id);
  const orgNodeId = readString(row.org_node_id);
  if (id === undefined || orgNodeId === undefined) return null;
  return { id, orgNodeId, active: row.active === true || row.active === 'true' || row.active === 't' };
}

const SELECT_EPISODE_PATIENT_SQL =
  'SELECT id, patient_id FROM episodes WHERE tenant_id = $1 AND id = $2';

const LIST_TRIAGES_SQL = `SELECT ${TRIAGE_COLUMNS}
FROM triages WHERE tenant_id = $1 AND patient_id = $2
ORDER BY at DESC NULLS LAST, id DESC LIMIT ${TRIAGE_LIST_LIMIT}`;

const INSERT_TRIAGE_SQL = `INSERT INTO triages
  (tenant_id, patient_id, episode_id, recorded_by, values, at)
VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))
RETURNING ${TRIAGE_COLUMNS}`;

// ============ use cases ============

/**
 * Vital-signs history of one patient inside the caller scope (`patient.read`).
 * Insert-only has no by-id read: the history is the record.
 */
export async function listTriages(
  actor: ActorContext,
  patientId: string,
): Promise<TriageRecord[]> {
  const id = requireUuidParam(patientId, 'patient id', actor.traceId);
  const patient = await findPatientScope(actor, id);
  if (patient === null) throw notFound('patient_file', actor.traceId);

  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'patient.read',
    orgNodeId: patient.orgNodeId,
    attemptedAction: 'triage.list',
  });
  const result = await actor.client.query(LIST_TRIAGES_SQL, [actor.tenantId, patient.id]);
  return readRows(result).map(mapTriage);
}

/**
 * Records one vital-signs row (`patient.write`). The recorder is the caller and
 * the moment defaults to the server clock; an optional episode must belong to
 * the same patient, otherwise the write is refused before the guard runs.
 */
export async function createTriage(actor: ActorContext, body: unknown): Promise<TriageRecord> {
  const input = parseTriageCreate(body, actor.traceId);
  const patient = await findPatientScope(actor, input.patientId);
  if (patient === null) throw notFound('patient_file', actor.traceId);

  if (input.episodeId !== null) {
    const episode = await actor.client.query(SELECT_EPISODE_PATIENT_SQL, [
      actor.tenantId,
      input.episodeId,
    ]);
    const row = readRows(episode)[0];
    if (row === undefined) throw notFound('episode', actor.traceId);
    if (readString(row.patient_id) !== patient.id) {
      throw badRequest('episode does not belong to the patient', actor.traceId);
    }
  }

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'patient.write',
    orgNodeId: patient.orgNodeId,
    stateAllows: patient.active,
    attemptedAction: 'triage.create',
  });

  // B2: `active` definitions of (salud, triage) type `values` — a missing
  // `required` code or a mistyped value refuses the write before the insert.
  validateCustomValues(
    await loadActiveDefs(actor.client, actor.tenantId, CUSTOM_FIELD_MODULE_SALUD, CUSTOM_FIELD_ENTITY_TRIAGE),
    input.values,
    actor.traceId,
  );

  const result = await actor.client.query(INSERT_TRIAGE_SQL, [
    actor.tenantId,
    patient.id,
    input.episodeId,
    actor.userId,
    JSON.stringify(input.values),
    input.at,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Triage insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const triage = mapTriage(row);
  await writeAudit(actor, membership, {
    action: 'triage.created',
    entityId: triage.id,
    orgNodeId: patient.orgNodeId,
    diff: { patientId: patient.id, episodeId: triage.episodeId },
  });
  return triage;
}
