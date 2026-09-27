// Prescription service — template-based orders (bases-consolidadas-v1.md §2.3).
//
// Migration 003 declares `prescriptions` with a `draft → issued` happy path and
// `cancelled` as the terminal refusal. This slice exposes only the history read
// and the create write; the status transitions arrive in a later slice, so a
// created row stays in the status it was born with. Deliberately plain like
// `salud.service.ts` — no decorators, so it stays loadable under strip-only
// TypeScript — with the same split: the thin `prescriptions.controller.ts` owns
// HTTP, this module owns validation, the guard, the sede scope and the write
// audit.
//
// Scope rule: `prescriptions` carries no `org_node_id`; the scope travels
// through the episode's patient sede. The patient itself is derived from the
// episode server-side, so the create body carries no `patientId` that could
// disagree with it. Reads need `patient.read`, writes need `episode.write` over
// an `open` episode: prescribing into a closed episode is refused with
// `state.denied`, the same way `closeEpisode` treats a closed row.
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import { assertTransition } from '../state-transitions/state-transitions.service.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

/** Tenant module this vertical requires (bases §3.1 property 6 / §3.5). */
export const SALUD_MODULE = 'salud';

/** Rows the history read returns at most; keeps a stray wide scan bounded. */
export const PRESCRIPTION_LIST_LIMIT = 200;

/** `prescriptions.status` catalog (migration 003 CHECK). */
export const PRESCRIPTION_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

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
const TEMPLATE_CODE_MAX = 120;
const ITEM_DESCRIPTION_MAX = 280;
const ITEMS_MAX = 100;

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

/** `jsonb` arrives as an array from `pg`; tolerate a stored string payload. */
function readJsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
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

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record[key])?.trim();
  return value === undefined || value === '' ? undefined : value;
}

// ============ validation ============

/** One ordered line: what to dispense or apply, and how. */
export interface PrescriptionItem {
  readonly description: string;
  readonly quantity?: number;
  readonly dose?: string;
  readonly frequency?: string;
  readonly instructions?: string;
}

function parseItem(value: unknown, traceId: string): PrescriptionItem {
  const record = asRecord(value);
  const description = requireString(record, 'description', traceId);
  if (description.length > ITEM_DESCRIPTION_MAX) {
    throw badRequest('item description exceeds 280 characters', traceId);
  }
  let quantity: number | undefined;
  if (record.quantity !== undefined) {
    const raw = record.quantity;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      throw badRequest('item quantity must be a positive integer', traceId);
    }
    quantity = raw;
  }
  const dose = optionalString(record, 'dose');
  const frequency = optionalString(record, 'frequency');
  const instructions = optionalString(record, 'instructions');
  return {
    description,
    ...(quantity === undefined ? {} : { quantity }),
    ...(dose === undefined ? {} : { dose }),
    ...(frequency === undefined ? {} : { frequency }),
    ...(instructions === undefined ? {} : { instructions }),
  };
}

interface PrescriptionCreateInput {
  readonly episodeId: string;
  readonly templateCode: string;
  readonly items: PrescriptionItem[];
  readonly status: PrescriptionStatus;
}

function readStatus(value: unknown): PrescriptionStatus {
  const text = readString(value);
  return (PRESCRIPTION_STATUSES as readonly string[]).includes(text ?? '')
    ? (text as PrescriptionStatus)
    : 'draft';
}

function parsePrescriptionCreate(body: unknown, traceId: string): PrescriptionCreateInput {
  const record = asRecord(body);
  const templateCode = requireString(record, 'templateCode', traceId);
  if (templateCode.length > TEMPLATE_CODE_MAX) {
    throw badRequest('templateCode exceeds 120 characters', traceId);
  }
  const rawItems = record.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw badRequest('items must carry at least one prescription line', traceId);
  }
  if (rawItems.length > ITEMS_MAX) {
    throw badRequest('items exceeds 100 prescription lines', traceId);
  }
  let status: PrescriptionStatus = 'draft';
  if (record.status !== undefined) {
    const text = requireString(record, 'status', traceId);
    if (!(PRESCRIPTION_STATUSES as readonly string[]).includes(text)) {
      throw badRequest(`Invalid status (expected draft|issued|cancelled): ${text}`, traceId);
    }
    status = text as PrescriptionStatus;
  }
  return {
    episodeId: requireUuid(record, 'episodeId', traceId),
    templateCode,
    items: rawItems.map((item) => parseItem(item, traceId)),
    status,
  };
}

// ============ row shape ============

/** One prescription order as the API exposes it. */
export interface PrescriptionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly templateCode: string;
  readonly items: PrescriptionItem[];
  readonly status: PrescriptionStatus;
}

const PRESCRIPTION_COLUMNS =
  'id, tenant_id, patient_id, episode_id, template_code, items, status';

function mapPrescription(row: Record<string, unknown>): PrescriptionRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    patientId: readString(row.patient_id) ?? '',
    episodeId: readString(row.episode_id) ?? '',
    templateCode: readString(row.template_code) ?? '',
    items: readJsonArray(row.items).map((item) => parseItem(item, 'prescription.read')),
    status: readStatus(row.status),
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
      entity: 'prescription',
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
    'prescription',
    entry.entityId,
    entry.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...entry.diff }),
    actor.ip,
  ]);
}

// ============ row I/O ============

interface EpisodeScope {
  readonly id: string;
  readonly patientId: string;
  readonly orgNodeId: string;
  readonly status: string;
}

const SELECT_EPISODE_SQL = `SELECT e.id, e.patient_id, e.status, p.org_node_id
FROM episodes e
JOIN patient_files p ON p.id = e.patient_id AND p.tenant_id = e.tenant_id
WHERE e.tenant_id = $1 AND e.id = $2`;

const SELECT_PATIENT_SQL =
  'SELECT id, tenant_id, org_node_id FROM patient_files WHERE tenant_id = $1 AND id = $2';

async function findEpisodeScope(
  actor: ActorContext,
  episodeId: string,
): Promise<EpisodeScope | null> {
  const result = await actor.client.query(SELECT_EPISODE_SQL, [actor.tenantId, episodeId]);
  const row = readRows(result)[0];
  if (row === undefined) return null;
  const id = readString(row.id);
  const patientId = readString(row.patient_id);
  const orgNodeId = readString(row.org_node_id);
  if (id === undefined || patientId === undefined || orgNodeId === undefined) return null;
  return { id, patientId, orgNodeId, status: readString(row.status) ?? '' };
}

async function findPatientOrgNode(
  actor: ActorContext,
  patientId: string,
): Promise<string | null> {
  const result = await actor.client.query(SELECT_PATIENT_SQL, [actor.tenantId, patientId]);
  const row = readRows(result)[0];
  return row === undefined ? null : (readString(row.org_node_id) ?? null);
}

const LIST_BY_PATIENT_SQL = `SELECT ${PRESCRIPTION_COLUMNS}
FROM prescriptions WHERE tenant_id = $1 AND patient_id = $2
ORDER BY id DESC LIMIT ${PRESCRIPTION_LIST_LIMIT}`;

const LIST_BY_EPISODE_SQL = `SELECT ${PRESCRIPTION_COLUMNS}
FROM prescriptions WHERE tenant_id = $1 AND episode_id = $2
ORDER BY id DESC LIMIT ${PRESCRIPTION_LIST_LIMIT}`;

const INSERT_PRESCRIPTION_SQL = `INSERT INTO prescriptions
  (tenant_id, patient_id, episode_id, template_code, items, status)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
RETURNING ${PRESCRIPTION_COLUMNS}`;

const SELECT_PRESCRIPTION_SQL = `SELECT ${PRESCRIPTION_COLUMNS}
FROM prescriptions WHERE tenant_id = $1 AND id = $2`;

const UPDATE_PRESCRIPTION_STATUS_SQL = `UPDATE prescriptions
SET status = $3
WHERE tenant_id = $1 AND id = $2
RETURNING ${PRESCRIPTION_COLUMNS}`;

/**
 * P4-2a close-out: the catalog (`state_transitions`, entity `prescription`,
 * migration 011) lists exactly `draft → issued` and `draft → cancelled`.
 * Anything else is denied with 403, so the code needs no machine of its own
 * — only the 400 for a target outside the `{issued, cancelled}` pair.
 */
export const PRESCRIPTION_TRANSITION_TARGETS = ['issued', 'cancelled'] as const;
export type PrescriptionTransitionTarget = (typeof PRESCRIPTION_TRANSITION_TARGETS)[number];

// ============ use cases ============

/**
 * Prescription history filtered by patient or episode (`patient.read`). At
 * least one filter is required: without it the endpoint would scan the whole
 * tenant instead of one clinical history.
 */
export async function listPrescriptions(
  actor: ActorContext,
  filter: { readonly patientId?: string; readonly episodeId?: string },
): Promise<PrescriptionRecord[]> {
  const episodeId =
    filter.episodeId === undefined || filter.episodeId === ''
      ? null
      : requireUuidParam(filter.episodeId, 'episode id', actor.traceId);
  const patientId =
    filter.patientId === undefined || filter.patientId === ''
      ? null
      : requireUuidParam(filter.patientId, 'patient id', actor.traceId);
  if (episodeId === null && patientId === null) {
    throw badRequest('Provide a patient or an episode filter', actor.traceId);
  }

  const facts = await loadFacts(actor);
  if (episodeId !== null) {
    const episode = await findEpisodeScope(actor, episodeId);
    if (episode === null) throw notFound('episode', actor.traceId);
    await authorize(actor, facts, {
      action: 'patient.read',
      orgNodeId: episode.orgNodeId,
      attemptedAction: 'prescription.list',
    });
    const result = await actor.client.query(LIST_BY_EPISODE_SQL, [actor.tenantId, episode.id]);
    return readRows(result).map(mapPrescription);
  }

  const orgNodeId = await findPatientOrgNode(actor, patientId as string);
  if (orgNodeId === null) throw notFound('patient_file', actor.traceId);
  await authorize(actor, facts, {
    action: 'patient.read',
    orgNodeId,
    attemptedAction: 'prescription.list',
  });
  const result = await actor.client.query(LIST_BY_PATIENT_SQL, [actor.tenantId, patientId]);
  return readRows(result).map(mapPrescription);
}

/**
 * Creates one prescription order (`episode.write`) for an `open` episode. The
 * patient is read from the episode itself, so the body cannot smuggle a
 * patient the episode does not belong to.
 */
export async function createPrescription(
  actor: ActorContext,
  body: unknown,
): Promise<PrescriptionRecord> {
  const input = parsePrescriptionCreate(body, actor.traceId);
  const episode = await findEpisodeScope(actor, input.episodeId);
  if (episode === null) throw notFound('episode', actor.traceId);

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'episode.write',
    orgNodeId: episode.orgNodeId,
    stateAllows: episode.status === 'open',
    attemptedAction: 'prescription.create',
  });

  const result = await actor.client.query(INSERT_PRESCRIPTION_SQL, [
    actor.tenantId,
    episode.patientId,
    episode.id,
    input.templateCode,
    JSON.stringify(input.items),
    input.status,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Prescription insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const prescription = mapPrescription(row);
  await writeAudit(actor, membership, {
    action: 'prescription.created',
    entityId: prescription.id,
    orgNodeId: episode.orgNodeId,
    diff: {
      episodeId: episode.id,
      patientId: episode.patientId,
      templateCode: prescription.templateCode,
      status: prescription.status,
      items: prescription.items.length,
    },
  });
  return prescription;
}

// ============ transitions (P4-2a: Emitir / Anular) ============

/**
 * `PATCH /v1/salud/prescriptions/:id` — Emite (`issued`) or Anula
 * (`cancelled`) a `draft` order of an `open` episode, by the `episode.write`
 * role (`medico`). A target outside the pair is a 400; a `draft` of a
 * closed episode, an already-issued order, or a caller without the clinical
 * write is a 403 audited as `access.denied`. Every accepted move appends
 * one `audit_log` row (`prescription.issued` / `prescription.cancelled`).
 */
export async function transitionPrescription(
  actor: ActorContext,
  prescriptionId: string,
  status: unknown,
): Promise<PrescriptionRecord> {
  requireUuidParam(prescriptionId, 'prescription id', actor.traceId);
  const target = typeof status === 'string' ? status.trim() : '';
  if (!(PRESCRIPTION_TRANSITION_TARGETS as readonly string[]).includes(target)) {
    throw badRequest(
      `Invalid status (expected issued|cancelled): ${String(status)}`,
      actor.traceId,
    );
  }
  const current = await actor.client.query(SELECT_PRESCRIPTION_SQL, [
    actor.tenantId,
    prescriptionId,
  ]);
  const currentRow = readRows(current)[0];
  if (currentRow === undefined) throw notFound('prescription', actor.traceId);
  const prescription = mapPrescription(currentRow);
  if (prescription.status === target) return prescription;

  const episode = await findEpisodeScope(actor, prescription.episodeId);
  if (episode === null) throw notFound('episode', actor.traceId);

  const facts = await loadFacts(actor);
  // The catalog is the sole authority over the move (fail-closed when the
  // 011 seed is absent); the episode must additionally be `open`.
  const transitionAllows = await assertTransition(actor.client, {
    entity: 'prescription',
    from: prescription.status,
    to: target,
    role: facts.membership?.role ?? '',
    tenantId: actor.tenantId,
  });
  const membership = await authorize(actor, facts, {
    action: 'episode.write',
    entityId: prescription.id,
    orgNodeId: episode.orgNodeId,
    stateAllows: episode.status === 'open' && transitionAllows,
    attemptedAction: 'prescription.transition',
  });
  const result = await actor.client.query(UPDATE_PRESCRIPTION_STATUS_SQL, [
    actor.tenantId,
    prescription.id,
    target,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Prescription transition returned no row', traceId: actor.traceId },
      500,
    );
  }
  const updated = mapPrescription(row);
  await writeAudit(actor, membership, {
    action: target === 'issued' ? 'prescription.issued' : 'prescription.cancelled',
    entityId: updated.id,
    orgNodeId: episode.orgNodeId,
    diff: {
      from: prescription.status,
      to: updated.status,
      episodeId: episode.id,
      patientId: updated.patientId,
    },
  });
  return updated;
}
