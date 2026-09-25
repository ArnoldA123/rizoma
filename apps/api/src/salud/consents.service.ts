// Informed-consent service for the Peru teleinterconsultation template
// (docs/crm-maleable/peru-anexo-v1.md §2).
//
// Deliberately plain, like `salud.service.ts`: no decorators, because `npm
// test` loads the sources through Node's strip-only TypeScript, which rejects
// decorator syntax. The HTTP skin lives in `consents.controller.ts` and stays
// thin; this module owns the whole use case:
//   1. validate the §2.3 form fields and the §2.6 decision matrix;
//   2. build the guard facts (membership, org-node subtree, tenant module) and
//      evaluate the central rule through `canActivate` — which audits every
//      denial as `access.denied` — refusing on denial;
//   3. run tenant-scoped parameterized SQL (RLS already bound the request
//      transaction) and append one `audit_log` row per write.
//
// Lifecycle (§2.8): `pending → signed → revoked`, with `expired` reserved for
// the retention job. Signing requires the evidence `sha256` and the stored
// version payload (episode + centre pair + `informed_by`); revocation keeps the
// row and the evidence instead of deleting anything.
//
// Decision matrix (§2.6): the medical act is a hard `SI`/`NO` switch and the
// recording authorization is one `SI`/`NO` mark per type, with `todo`
// inclusive. `canStartSession` is the single gate a session-start caller must
// consult; `allowedRecordingTypes` is the single source of truth for what may
// be recorded or stored.
//
// Schema note (load-bearing, §2.8.1): migration 003 defines `consents` with
// only id, tenant_id, patient_id, template_code, version, signed_at,
// evidence_attachment_id and status — there is no metadata column. Because the
// consent version is a function of patient + episode + centre pair, this module
// persists the whole versioned payload (episode, centre pair, `informed_by`,
// the decision matrix and the §2.3 form snapshot) as canonical JSON in the
// existing `version` column. A dedicated metadata column belongs to a later
// migration; until then `version` is the single persistence surface and
// `decodeConsentVersion` fails closed when the payload cannot be read.
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

/** Tenant module this vertical requires (bases §3.1 property 6 / §3.5). */
export const SALUD_MODULE = 'salud';

/** `template_code` of the Peru teleinterconsultation consent (§2.2). */
export const CONSENT_TEMPLATE = 'consent.pe.teleinterconsulta';

/** Published template version stored beside every consent (§2.8.1). */
export const CONSENT_TEMPLATE_VERSION = '2025.1';

/** Discriminator written inside the encoded `version` payload. */
const CONSENT_SCHEMA = 'consent.pe.teleinterconsulta/v1';

/** Recording types of §2.6, in the order the matrix lists them. */
export const RECORD_TYPES = ['imagenes_ayuda', 'fotografias', 'video', 'audio'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Inclusive recording scope of §2.6: `SI` enables every type. */
export const RECORDING_SCOPE_ALL = 'todo';

/** `SI`/`NO` are the only two marks the form accepts (§2.6). */
export const RECORDING_MARKS = ['SI', 'NO'] as const;
export type RecordingMark = (typeof RECORDING_MARKS)[number];

/** Per-type (plus `todo`) decision map of §2.6. */
export type ConsentRecording = { readonly [key: string]: RecordingMark };

/** Medical-act decision of §2.6; only `SI` authorizes the act. */
export type ActConsent = 'SI' | 'NO';

/** `consents.status` catalog (migration 003). */
export const CONSENT_STATUSES = ['pending', 'signed', 'revoked', 'expired'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/** §2.3 document catalog for the patient identity snapshot. */
const DOCUMENT_TYPES = ['dni', 'ce', 'pasaporte'] as const;
const DNI_RE = /^\d{8}$/;

/** Reason codes the validation and lifecycle expose in the error envelope. */
export const CONSENT_REASON = {
  actRequired: 'consent.act_required',
  recordingRequired: 'consent.recording_required',
  invalidType: 'consent.invalid_type',
  evidenceRequired: 'consent.evidence_required',
  centersRequired: 'consent.centers_required',
  informedByRequired: 'consent.informed_by_required',
} as const;
export type ConsentReason = (typeof CONSENT_REASON)[keyof typeof CONSENT_REASON];

// ============ error envelope ============

/** 400 envelope for a body/param that fails validation. */
function badRequest(code: string, message: string, traceId: string): HttpException {
  return new HttpException({ code, message, traceId }, 400);
}

/** 400 envelope carrying a §2.6 reason code. */
function consentViolation(reason: ConsentReason, message: string, traceId: string): HttpException {
  return new HttpException({ code: reason, message, reason, traceId }, 400);
}

/** 403 envelope carrying the guard reason for observability. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 404 envelope for a consent/patient that does not exist in the tenant. */
function notFound(entity: string, traceId: string): HttpException {
  return new HttpException({ code: 'not_found', message: `${entity} not found`, traceId }, 404);
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

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

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function requireString(body: Record<string, unknown>, key: string, traceId: string): string {
  const value = readString(body[key])?.trim();
  if (value === undefined || value === '') {
    throw badRequest('validation.failed', `Missing required field: ${key}`, traceId);
  }
  return value;
}

function requireUuid(body: Record<string, unknown>, key: string, traceId: string): string {
  const value = requireString(body, key, traceId);
  if (!UUID_RE.test(value)) {
    throw badRequest('validation.failed', `Invalid UUID in field: ${key}`, traceId);
  }
  return value;
}

/** Rejects a path param that is not a UUID before any query runs. */
function requireUuidParam(value: string, label: string, traceId: string): string {
  if (!UUID_RE.test(value)) throw badRequest('validation.failed', `Invalid ${label}`, traceId);
  return value;
}

// ============ §2.3 / §2.6 validation ============

/** §2.3 form fields captured with the signed consent. */
export interface ConsentFormSnapshot {
  readonly patientName: string;
  readonly docType: string;
  readonly docNumber: string;
}

/** Normalized, guaranteed-valid form + decision matrix. */
export interface ValidatedConsentInput extends ConsentFormSnapshot {
  readonly actConsent: ActConsent;
  readonly recording: ConsentRecording;
}

/** Kinds the `recording` object may carry: the four types plus `todo`. */
const RECORDING_SCOPES: readonly string[] = [...RECORD_TYPES, RECORDING_SCOPE_ALL];

function isMark(value: unknown): value is RecordingMark {
  return typeof value === 'string' && (RECORDING_MARKS as readonly string[]).includes(value);
}

/**
 * Normalizes the recording map to the known kinds in matrix order. Unknown keys
 * and non-`SI`/`NO` marks are rejected instead of silently dropped, so a typo
 * cannot turn into an unauthorized recording (§2.6 "sin autorización no se
 * inicia grabación").
 */
function parseRecording(value: unknown, traceId: string): ConsentRecording {
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw consentViolation(
      CONSENT_REASON.recordingRequired,
      'recording consent is required: mark at least one type SI or NO',
      traceId,
    );
  }
  const normalized: Record<string, RecordingMark> = {};
  for (const [key, mark] of entries) {
    if (!RECORDING_SCOPES.includes(key)) {
      throw consentViolation(
        CONSENT_REASON.invalidType,
        `Unknown recording type: ${key}`,
        traceId,
      );
    }
    if (!isMark(mark)) {
      throw consentViolation(
        CONSENT_REASON.invalidType,
        `Recording type ${key} must be SI or NO`,
        traceId,
      );
    }
    normalized[key] = mark;
  }
  return normalized;
}

/**
 * Validates the §2.3 form fields and the §2.6 decision matrix. Throws a 400
 * envelope carrying one of the `consent.*` reason codes; returns the
 * normalized values otherwise.
 */
export function validateConsentInput(input: unknown, traceId: string): ValidatedConsentInput {
  const record = asRecord(input);

  const patientName = readString(record.patientName)?.trim() ?? '';
  if (patientName === '') {
    throw badRequest('validation.failed', 'Missing required field: patientName', traceId);
  }
  // §2.3: the form is completed in capital letters; the stored snapshot keeps
  // that normalization so the signed name is reproducible.
  const form: ConsentFormSnapshot = {
    patientName: patientName.toUpperCase(),
    docType: requireString(record, 'docType', traceId),
    docNumber: requireString(record, 'docNumber', traceId),
  };
  if (!(DOCUMENT_TYPES as readonly string[]).includes(form.docType)) {
    throw consentViolation(
      CONSENT_REASON.invalidType,
      `Invalid docType (expected dni|ce|pasaporte): ${form.docType}`,
      traceId,
    );
  }
  if (form.docType === 'dni' && !DNI_RE.test(form.docNumber)) {
    throw badRequest('validation.failed', 'A DNI docNumber must be exactly 8 digits', traceId);
  }

  // §2.6 medical act: `SI` authorizes, `NO` blocks, anything else is invalid.
  if (!isMark(record.actConsent)) {
    throw consentViolation(
      CONSENT_REASON.actRequired,
      'actConsent is required and must be SI or NO',
      traceId,
    );
  }

  return {
    ...form,
    actConsent: record.actConsent,
    recording: parseRecording(record.recording, traceId),
  };
}

// ============ decision matrix (§2.6) ============

/**
 * Effective mark of one recording type: an explicit per-type mark wins over the
 * inclusive `todo` mark; an unmarked type defaults to `NO` (fail closed).
 */
export function effectiveRecordingMark(
  recording: ConsentRecording,
  type: RecordType,
): RecordingMark {
  const explicit = recording[type];
  if (isMark(explicit)) return explicit;
  const all = recording[RECORDING_SCOPE_ALL];
  return isMark(all) ? all : 'NO';
}

/**
 * Single gate for starting a teleinterconsultation (§2.8 rule 3): only a
 * `signed` consent whose medical act is `SI` authorizes the session. A `NO`
 * act, a pending row and a revoked row all block; the caller audits the denial.
 */
export function canStartSession(consent: Pick<ConsentRecord, 'status' | 'actConsent'>): boolean {
  return consent.status === 'signed' && consent.actConsent === 'SI';
}

/**
 * Recording types that may be recorded/stored (§2.8 rule 4): the types marked
 * `SI`, with `todo` expanding to the whole catalog, in matrix order.
 */
export function allowedRecordingTypes(consent: Pick<ConsentRecord, 'recording'>): string[] {
  const allowed: string[] = [];
  for (const type of RECORD_TYPES) {
    if (effectiveRecordingMark(consent.recording, type) === 'SI') allowed.push(type);
  }
  return allowed;
}

// ============ version payload (§2.8.1) ============

/**
 * The versioned payload of one consent. Stored as canonical JSON in
 * `consents.version` (see the schema note at the top of the file).
 */
export interface ConsentVersionPayload {
  readonly schema: string;
  /** Version key: template + version + patient + episode + centre pair. */
  readonly key: string;
  readonly version: string;
  readonly episodeId: string;
  readonly consultingCenter: string;
  readonly consultorCenter: string;
  readonly informedBy: string;
  readonly actConsent: ActConsent;
  readonly recording: ConsentRecording;
  readonly form: ConsentFormSnapshot;
}

/** Version key of §2.8.1: patient + episode + centre pair (+ template/version). */
export function consentVersionKey(input: {
  readonly patientId: string;
  readonly episodeId: string;
  readonly consultingCenter: string;
  readonly consultorCenter: string;
}): string {
  return [
    CONSENT_TEMPLATE,
    CONSENT_TEMPLATE_VERSION,
    input.patientId,
    input.episodeId,
    input.consultingCenter,
    input.consultorCenter,
  ].join('/');
}

/** Input for {@link buildConsentVersion}: the versioned coordinates + matrix. */
export interface ConsentVersionInput {
  readonly patientId: string;
  readonly episodeId: string;
  readonly consultingCenter: string;
  readonly consultorCenter: string;
  readonly informedBy: string;
  readonly actConsent: ActConsent;
  readonly recording: ConsentRecording;
  readonly form: ConsentFormSnapshot;
}

/** Builds the versioned payload, deriving the §2.8.1 key from its coordinates. */
export function buildConsentVersion(input: ConsentVersionInput): ConsentVersionPayload {
  return {
    schema: CONSENT_SCHEMA,
    key: consentVersionKey(input),
    version: CONSENT_TEMPLATE_VERSION,
    episodeId: input.episodeId,
    consultingCenter: input.consultingCenter,
    consultorCenter: input.consultorCenter,
    informedBy: input.informedBy,
    actConsent: input.actConsent,
    recording: input.recording,
    form: input.form,
  };
}

/** Deterministic key order, so equal decisions encode to equal strings. */
function orderRecording(recording: ConsentRecording): Record<string, RecordingMark> {
  const ordered: Record<string, RecordingMark> = {};
  for (const type of RECORD_TYPES) {
    if (isMark(recording[type])) ordered[type] = recording[type];
  }
  if (isMark(recording[RECORDING_SCOPE_ALL])) {
    ordered[RECORDING_SCOPE_ALL] = recording[RECORDING_SCOPE_ALL];
  }
  return ordered;
}

/** Canonical JSON encoding stored in the `version` column. */
export function encodeConsentVersion(payload: ConsentVersionPayload): string {
  return JSON.stringify({
    schema: CONSENT_SCHEMA,
    key: payload.key,
    version: payload.version,
    episodeId: payload.episodeId,
    consultingCenter: payload.consultingCenter,
    consultorCenter: payload.consultorCenter,
    informedBy: payload.informedBy,
    actConsent: payload.actConsent,
    recording: orderRecording(payload.recording),
    form: {
      patientName: payload.form.patientName,
      docType: payload.form.docType,
      docNumber: payload.form.docNumber,
    },
  });
}

function readRecording(value: unknown): ConsentRecording | null {
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length === 0) return {};
  const recording: Record<string, RecordingMark> = {};
  for (const [key, mark] of entries) {
    if (!RECORDING_SCOPES.includes(key) || !isMark(mark)) return null;
    recording[key] = mark;
  }
  return recording;
}

/**
 * Decodes the stored `version` payload. Returns `null` for anything that is not
 * a well-formed payload this module wrote, so an unreadable or foreign row
 * fails closed (no session, no recording type) instead of guessing.
 */
export function decodeConsentVersion(raw: unknown): ConsentVersionPayload | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record.schema !== CONSENT_SCHEMA) return null;
  const actConsent = record.actConsent;
  if (!isMark(actConsent)) return null;
  const recording = readRecording(record.recording);
  if (recording === null) return null;
  const episodeId = readString(record.episodeId);
  const consultingCenter = readString(record.consultingCenter);
  const consultorCenter = readString(record.consultorCenter);
  const informedBy = readString(record.informedBy);
  const key = readString(record.key);
  const version = readString(record.version);
  const form = asRecord(record.form);
  const patientName = readString(form.patientName);
  const docType = readString(form.docType);
  const docNumber = readString(form.docNumber);
  if (
    episodeId === undefined ||
    consultingCenter === undefined ||
    consultorCenter === undefined ||
    informedBy === undefined ||
    key === undefined ||
    version === undefined ||
    patientName === undefined ||
    docType === undefined ||
    docNumber === undefined
  ) {
    return null;
  }
  return {
    schema: CONSENT_SCHEMA,
    key,
    version,
    episodeId,
    consultingCenter,
    consultorCenter,
    informedBy,
    actConsent,
    recording,
    form: { patientName, docType, docNumber },
  };
}

// ============ row shape ============

/** One consent as the API exposes it, with the §2.6 gate already derived. */
export interface ConsentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly templateCode: string;
  readonly templateVersion: string;
  /** Version key of §2.8.1 (patient + episode + centre pair). */
  readonly versionKey: string;
  readonly episodeId: string;
  readonly consultingCenter: string;
  readonly consultorCenter: string;
  readonly informedBy: string;
  readonly patientName: string;
  readonly docType: string;
  readonly docNumber: string;
  readonly actConsent: ActConsent;
  readonly recording: ConsentRecording;
  readonly signedAt: string | null;
  readonly evidenceAttachmentId: string | null;
  readonly status: ConsentStatus;
  /** Derived gate: `signed` + act `SI` (see {@link canStartSession}). */
  readonly canStartSession: boolean;
  /** Derived: recording types marked `SI` (see {@link allowedRecordingTypes}). */
  readonly allowedRecordingTypes: readonly string[];
}

const CONSENT_COLUMNS =
  'id, tenant_id, patient_id, template_code, version, signed_at, evidence_attachment_id, status';

function readStatus(value: unknown): ConsentStatus {
  const text = readString(value);
  return (CONSENT_STATUSES as readonly string[]).includes(text ?? '')
    ? (text as ConsentStatus)
    : 'pending';
}

/**
 * Maps one `consents` row. A payload that cannot be decoded yields an empty
 * matrix whose act defaults to `NO`, i.e. the gate and the recording types both
 * fail closed.
 */
function mapConsent(row: Record<string, unknown>): ConsentRecord {
  const payload = decodeConsentVersion(row.version);
  const recording: ConsentRecording = payload?.recording ?? {};
  const actConsent: ActConsent = payload?.actConsent ?? 'NO';
  const status = readStatus(row.status);
  const record: Omit<ConsentRecord, 'canStartSession' | 'allowedRecordingTypes'> = {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    patientId: readString(row.patient_id) ?? '',
    templateCode: readString(row.template_code) ?? CONSENT_TEMPLATE,
    templateVersion: payload?.version ?? '',
    versionKey: payload?.key ?? '',
    episodeId: payload?.episodeId ?? '',
    consultingCenter: payload?.consultingCenter ?? '',
    consultorCenter: payload?.consultorCenter ?? '',
    informedBy: payload?.informedBy ?? '',
    patientName: payload?.form.patientName ?? '',
    docType: payload?.form.docType ?? '',
    docNumber: payload?.form.docNumber ?? '',
    actConsent,
    recording,
    signedAt: toIso(row.signed_at),
    evidenceAttachmentId: readString(row.evidence_attachment_id) ?? null,
    status,
  };
  return {
    ...record,
    canStartSession: canStartSession(record),
    allowedRecordingTypes: allowedRecordingTypes(record),
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
      entity: 'consent',
      entityId: options.entityId ?? null,
      orgNodeId: options.orgNodeId,
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

interface AuditEntry {
  readonly action: string;
  readonly entityId: string;
  readonly orgNodeId: string;
  readonly diff: Record<string, unknown>;
}

/** Appends one row per successful write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: ActorContext,
  membership: MembershipRecord,
  entry: AuditEntry,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    entry.action,
    'consent',
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
}

const SELECT_PATIENT_SQL =
  'SELECT id, tenant_id, org_node_id FROM patient_files WHERE tenant_id = $1 AND id = $2';

async function findPatientScope(
  actor: ActorContext,
  patientId: string,
): Promise<PatientScope | null> {
  const result = await actor.client.query(SELECT_PATIENT_SQL, [actor.tenantId, patientId]);
  const row = readRows(result)[0];
  if (row === undefined) return null;
  const id = readString(row.id);
  const orgNodeId = readString(row.org_node_id);
  return id === undefined || orgNodeId === undefined ? null : { id, orgNodeId };
}

const SELECT_CONSENT_SQL = `SELECT ${CONSENT_COLUMNS}
FROM consents WHERE tenant_id = $1 AND id = $2`;

async function findConsent(
  actor: ActorContext,
  consentId: string,
): Promise<ConsentRecord | null> {
  const result = await actor.client.query(SELECT_CONSENT_SQL, [actor.tenantId, consentId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapConsent(row);
}

const LIST_CONSENTS_SQL = `SELECT ${CONSENT_COLUMNS}
FROM consents WHERE tenant_id = $1 AND patient_id = $2
ORDER BY signed_at DESC NULLS LAST, id`;

const INSERT_CONSENT_SQL = `INSERT INTO consents
  (tenant_id, patient_id, template_code, version, status)
VALUES ($1, $2, $3, $4, 'pending')
RETURNING ${CONSENT_COLUMNS}`;

const SIGN_CONSENT_SQL = `UPDATE consents
SET status = 'signed', signed_at = now(), evidence_attachment_id = $3
WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
RETURNING ${CONSENT_COLUMNS}`;

const REVOKE_CONSENT_SQL = `UPDATE consents
SET status = 'revoked'
WHERE tenant_id = $1 AND id = $2 AND status = 'signed'
RETURNING ${CONSENT_COLUMNS}`;

const INSERT_ATTACHMENT_SQL = `INSERT INTO attachments
  (tenant_id, bucket_key, sha256, mime, size_bytes, uploaded_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id`;

// ============ evidence (§2.8 rule 2) ============

interface EvidenceInput {
  readonly sha256: string;
  readonly bucketKey: string;
  readonly mime: string;
}

/** Reads `sha256`/`bucketKey`/`mime`, accepting a nested `evidence` object. */
function parseEvidence(
  body: unknown,
  defaults: { readonly patientId: string; readonly traceId: string },
): EvidenceInput {
  const record = asRecord(body);
  const nested = asRecord(record.evidence);
  const sha256 = (readString(record.evidenceSha256) ?? readString(nested.sha256))?.trim().toLowerCase();
  if (sha256 === undefined || !SHA256_RE.test(sha256)) {
    throw consentViolation(
      CONSENT_REASON.evidenceRequired,
      'evidenceSha256 is required and must be a 64-character hex digest',
      defaults.traceId,
    );
  }
  const bucketKey =
    readString(record.evidenceBucketKey) ?? readString(nested.bucketKey) ?? `consents/${defaults.patientId}/${sha256}.pdf`;
  const mime = readString(record.evidenceMime) ?? readString(nested.mime) ?? 'application/pdf';
  return { sha256, bucketKey, mime };
}

// ============ use cases ============

const INSERT_ACTION = 'consent.created';
const SIGN_ACTION = 'consent.signed';
const REVOKE_ACTION = 'consent.revoked';
/** Written in addition to `consent.signed` when the act is `NO` (§2.8 rule 3). */
const BLOCK_ACTION = 'consent.session_blocked';

interface ConsentCreateInput extends ValidatedConsentInput {
  readonly patientId: string;
  readonly episodeId: string;
  readonly consultingCenter: string;
  readonly consultorCenter: string;
  readonly informedBy: string;
}

/** Parses the §2.3/§2.6 body plus the versioning coordinates of §2.8.1. */
function parseConsentCreate(body: unknown, traceId: string): ConsentCreateInput {
  const record = asRecord(body);
  const validated = validateConsentInput(record, traceId);
  return {
    ...validated,
    patientId: requireUuid(record, 'patientId', traceId),
    episodeId: requireUuid(record, 'episodeId', traceId),
    consultingCenter: requireUuid(record, 'consultingCenter', traceId),
    consultorCenter: requireUuid(record, 'consultorCenter', traceId),
    informedBy: requireString(record, 'informedBy', traceId),
  };
}

/**
 * Creates the `pending` consent row for the teleinterconsultation template.
 * The version payload already carries the whole decision matrix, so signing
 * only has to attach the evidence and stamp `signed_at` (§2.8 rules 1–2).
 */
export async function createPending(actor: ActorContext, body: unknown): Promise<ConsentRecord> {
  const input = parseConsentCreate(body, actor.traceId);
  const patient = await findPatientScope(actor, input.patientId);
  if (patient === null) throw notFound('patient_file', actor.traceId);

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'patient.write',
    orgNodeId: patient.orgNodeId,
    attemptedAction: 'consent.create',
  });

  const payload = buildConsentVersion({
    patientId: input.patientId,
    episodeId: input.episodeId,
    consultingCenter: input.consultingCenter,
    consultorCenter: input.consultorCenter,
    informedBy: input.informedBy,
    actConsent: input.actConsent,
    recording: input.recording,
    form: {
      patientName: input.patientName,
      docType: input.docType,
      docNumber: input.docNumber,
    },
  });

  const result = await actor.client.query(INSERT_CONSENT_SQL, [
    actor.tenantId,
    patient.id,
    CONSENT_TEMPLATE,
    encodeConsentVersion(payload),
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Consent insert returned no row', traceId: actor.traceId },
      500,
    );
  }
  const consent = mapConsent(row);
  await writeAudit(actor, membership, {
    action: INSERT_ACTION,
    entityId: consent.id,
    orgNodeId: patient.orgNodeId,
    diff: {
      templateCode: consent.templateCode,
      templateVersion: consent.templateVersion,
      versionKey: consent.versionKey,
      episodeId: consent.episodeId,
      consultingCenter: consent.consultingCenter,
      consultorCenter: consent.consultorCenter,
      informedBy: consent.informedBy,
      actConsent: consent.actConsent,
      recording: consent.recording,
      allowedRecordingTypes: consent.allowedRecordingTypes,
      sessionBlocked: !consent.canStartSession,
    },
  });
  return consent;
}

/**
 * Signs a `pending` consent (§2.8 rule 2): requires the evidence `sha256`, then
 * stores the attachment, flips the row to `signed` and stamps `signed_at`. The
 * centre pair and `informed_by` of the version payload are re-checked so a row
 * written before this contract cannot be signed without them.
 */
export async function signConsent(
  actor: ActorContext,
  consentId: string,
  body: unknown,
): Promise<ConsentRecord> {
  const id = requireUuidParam(consentId, 'consent id', actor.traceId);
  const current = await findConsent(actor, id);
  if (current === null) throw notFound('consent', actor.traceId);
  const patient = await findPatientScope(actor, current.patientId);
  if (patient === null) throw notFound('patient_file', actor.traceId);

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'patient.write',
    entityId: current.id,
    orgNodeId: patient.orgNodeId,
    stateAllows: current.status === 'pending',
    attemptedAction: 'consent.sign',
  });

  if (
    current.consultingCenter === '' ||
    current.consultorCenter === '' ||
    current.episodeId === ''
  ) {
    throw consentViolation(
      CONSENT_REASON.centersRequired,
      'consent version is missing the episode or the consulting/consultor centre pair',
      actor.traceId,
    );
  }
  if (current.informedBy === '') {
    throw consentViolation(
      CONSENT_REASON.informedByRequired,
      'consent version is missing informed_by',
      actor.traceId,
    );
  }

  const evidence = parseEvidence(body, { patientId: current.patientId, traceId: actor.traceId });
  const attachment = await actor.client.query(INSERT_ATTACHMENT_SQL, [
    actor.tenantId,
    evidence.bucketKey,
    evidence.sha256,
    evidence.mime,
    0,
    actor.userId,
  ]);
  const attachmentId = readString(readRows(attachment)[0]?.id);
  if (attachmentId === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Attachment insert returned no row', traceId: actor.traceId },
      500,
    );
  }

  const result = await actor.client.query(SIGN_CONSENT_SQL, [actor.tenantId, id, attachmentId]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Consent sign returned no row', traceId: actor.traceId },
      500,
    );
  }
  const consent = mapConsent(row);
  await writeAudit(actor, membership, {
    action: SIGN_ACTION,
    entityId: consent.id,
    orgNodeId: patient.orgNodeId,
    diff: {
      evidenceAttachmentId: consent.evidenceAttachmentId,
      evidenceSha256: evidence.sha256,
      actConsent: consent.actConsent,
      recording: consent.recording,
      allowedRecordingTypes: consent.allowedRecordingTypes,
      sessionBlocked: !consent.canStartSession,
    },
  });
  // §2.8 rule 3: the hard block of a `NO` act is recorded as its own event, so
  // the refusal is visible in the trail without reading the signed diff.
  if (!consent.canStartSession) {
    await writeAudit(actor, membership, {
      action: BLOCK_ACTION,
      entityId: consent.id,
      orgNodeId: patient.orgNodeId,
      diff: { reason: CONSENT_REASON.actRequired, actConsent: consent.actConsent },
    });
  }
  return consent;
}

/**
 * Revokes a `signed` consent (§2.8 rule 7): `signed → revoked` blocks new
 * teleinterconsultations while the row and its evidence stay intact.
 */
export async function revokeConsent(
  actor: ActorContext,
  consentId: string,
): Promise<ConsentRecord> {
  const id = requireUuidParam(consentId, 'consent id', actor.traceId);
  const current = await findConsent(actor, id);
  if (current === null) throw notFound('consent', actor.traceId);
  const patient = await findPatientScope(actor, current.patientId);
  if (patient === null) throw notFound('patient_file', actor.traceId);

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: 'patient.write',
    entityId: current.id,
    orgNodeId: patient.orgNodeId,
    stateAllows: current.status === 'signed',
    attemptedAction: 'consent.revoke',
  });

  const result = await actor.client.query(REVOKE_CONSENT_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Consent revoke returned no row', traceId: actor.traceId },
      500,
    );
  }
  const consent = mapConsent(row);
  await writeAudit(actor, membership, {
    action: REVOKE_ACTION,
    entityId: consent.id,
    orgNodeId: patient.orgNodeId,
    diff: {
      from: 'signed',
      to: 'revoked',
      evidenceAttachmentId: consent.evidenceAttachmentId,
      actConsent: consent.actConsent,
    },
  });
  return consent;
}

/**
 * Consent history of one patient inside the caller scope (bases §3.1 property
 * 3: the patient's own sede drives the scope check). The evidence and the
 * version history are preserved by design.
 */
export async function listConsents(
  actor: ActorContext,
  patientId: string,
): Promise<ConsentRecord[]> {
  const id = requireUuidParam(patientId, 'patient id', actor.traceId);
  const patient = await findPatientScope(actor, id);
  if (patient === null) throw notFound('patient_file', actor.traceId);

  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'patient.read',
    orgNodeId: patient.orgNodeId,
    attemptedAction: 'consent.list',
  });
  const result = await actor.client.query(LIST_CONSENTS_SQL, [actor.tenantId, patient.id]);
  return readRows(result).map(mapConsent);
}
