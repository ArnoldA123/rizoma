// Patient CSV importer (bases-consolidadas-v1.md §5.1, §5.4).
//
// Deliberately plain, like `salud.service.ts` and `billing.service.ts`: no
// decorators, because `npm test` loads the sources through Node's strip-only
// TypeScript (which rejects decorator syntax). The HTTP skin lives in
// `import.controller.ts` and stays thin; this module owns the whole use case:
//   1. validate the body and parse the CSV into rows + per-row errors;
//   2. build the guard facts (membership, org-node subtree, tenant module) and
//      evaluate the central rule through `canActivate` — which audits every
//      denial as `access.denied` — refusing on denial;
//   3. insert every valid row as a patient file inside its own SAVEPOINT, so a
//      per-row failure is counted as a row error instead of aborting the run;
//      (a bare `catch` around the INSERT is not enough: in Postgres the failed
//      statement poisons the whole request transaction — SQLSTATE 25P02 — and
//      every later statement fails until the savepoint is rolled back)
//   4. mark the initial informed consent as `pending` for every imported
//      patient (§5.4: «consentimiento inicial marcado como pendiente»);
//   5. write the `import_jobs` contract row (`rows_ok`, `rows_error`, the
//      downloadable errors CSV) and one `audit_log` row.
//
// Idempotency contract (§5.4 «toda importación es idempotente por hash del
// archivo», §5.1): the SHA-256 of the CSV text is the replay key. A second
// upload of the same bytes returns the original job — including the errors CSV
// — instead of importing twice, even under a different `Idempotency-Key`
// header. The same bytes aimed at a different sede is a 409, because that is a
// different import intent rather than a retry. The required `Idempotency-Key`
// header of §5.1 is validated and recorded in the audit diff.
//
// Schema note (load-bearing): `import_jobs` (migration 001) has no file-hash
// and no content column, and the source/errors CSVs are object-storage objects
// (`attachments.bucket_key`) that no MVP1 component uploads. The run therefore
// persists metadata only — the CSV text in `attachments` by hash, the job row
// in `import_jobs`, and the full job response (which carries `errorsCsv`) in
// `idempotency_keys.response` JSONB, the existing §5.1 store. `getImportJob`
// reads the errors CSV back through the source attachment hash, so the job
// detail stays reproducible without a new column.
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction } from '../auth/policy.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

export type { ActorContext, SaludClient };

/** `import_jobs.kind` for the patients CSV importer (§5.4). */
export const IMPORT_KIND_PATIENT_FILES_CSV = 'patient_files_csv';

/** `template_code` of the initial consent the importer leaves pending (§5.4). */
export const IMPORT_CONSENT_TEMPLATE = 'consent.pe.teleinterconsulta';

/** Version stamped on the imported initial consent; signing carries the full
 * §2.8.1 payload, so the pre-signature row only needs a stable marker. */
export const IMPORT_CONSENT_VERSION = '1';

/** Header carrying the client idempotency key (§5.1). */
export const IMPORT_IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Key window kept in `idempotency_keys` (§5.1: 24 h). */
export const IMPORT_IDEMPOTENCY_WINDOW_HOURS = 24;

/** Rows the source attachment records; the CSV body itself is bounded by HTTP. */
export const IMPORT_ERROR = {
  csvRequired: 'import.csv_required',
  invalidCsv: 'import.invalid_csv',
  invalidOrgNode: 'import.invalid_org_node',
  idempotencyKeyRequired: 'import.idempotency_key_required',
  idempotencyConflict: 'import.idempotency_conflict',
  writeFailed: 'import.write_failed',
} as const;
export type ImportErrorCode = (typeof IMPORT_ERROR)[keyof typeof IMPORT_ERROR];

/** Per-row failure codes written into the downloadable errors CSV. */
export const IMPORT_ROW_ERROR = {
  fieldRequired: 'import.field_required',
  invalidDocumentType: 'import.invalid_document_type',
  invalidDate: 'import.invalid_date',
  invalidOrgNode: 'import.invalid_org_node',
  orgNodeOutOfScope: 'import.org_node_out_of_scope',
  documentDuplicate: 'import.document_duplicate',
} as const;
export type ImportRowErrorCode = (typeof IMPORT_ROW_ERROR)[keyof typeof IMPORT_ROW_ERROR];

// ============ error envelope ============

/** Domain envelope: `{code: 'import.*', message, traceId}`. */
function importError(code: ImportErrorCode, message: string, status: number, traceId: string): HttpException {
  return new HttpException({ code, message, traceId }, status);
}

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
  return new HttpException({ code: 'not_found', message: `${entity} not found`, traceId }, 404);
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENT_TYPES = ['dni', 'ce', 'pasaporte'] as const;

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
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

/** `pg` returns INT/BIGINT aggregates as string; normalize to a number. */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** SHA-256 hex digest, the file-hash replay key of §5.4. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Strict calendar check: `YYYY-MM-DD` and a date the calendar actually has. */
function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Today in UTC; the board date echo is a label, the SQL filter is the source. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Rejects a path param that is not a UUID before any query runs. */
function requireUuidParam(value: string, label: string, traceId: string): string {
  if (!UUID_RE.test(value)) throw badRequest(`Invalid ${label}`, traceId);
  return value;
}

// ============ CSV parsing (§5.4) ============

/** One validated CSV data row, ready to become a `patient_files` row. */
export interface PatientImportRow {
  /** 1-based line in the source file, header included. */
  readonly rowNumber: number;
  readonly personName: string;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly birthdate: string | null;
  /** Kept in `patient_files.contacts` JSONB: the table has no phone column. */
  readonly phone: string | null;
  /** Per-row sede override; null means «use the request `orgNodeId`». */
  readonly orgNodeId: string | null;
}

/** One per-row validation failure; the unit of the downloadable errors file. */
export interface PatientImportRowError {
  readonly rowNumber: number;
  readonly field: string;
  readonly code: ImportRowErrorCode;
  readonly message: string;
}

export interface ParsedPatientsCsv {
  readonly rows: readonly PatientImportRow[];
  readonly errors: readonly PatientImportRowError[];
}

/** Columns the importer reads by name; unknown columns are ignored. */
const CSV_COLUMNS = [
  'person_name',
  'document_type',
  'document_number',
  'birthdate',
  'phone',
  'org_node_id',
] as const;
const CSV_REQUIRED_COLUMNS = ['person_name', 'document_type', 'document_number'] as const;

/**
 * RFC 4180-style record splitter: quoted fields, `""` escapes, embedded commas
 * and newlines, both `\n` and `\r\n`. Returns one array of cells per record.
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      endRecord();
      continue;
    }
    field += char;
  }
  if (field !== '' || record.length > 0) endRecord();

  // Drop blank lines (nothing but empty cells) so a trailing newline is not a row.
  return records.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/**
 * Parses and validates the patients CSV. Structural problems (empty file, a
 * missing required column) throw a 400 envelope; per-row problems are returned
 * as `errors` and exclude only that row, so one bad line never aborts the file.
 */
export function parsePatientsCsv(csvText: string, traceId = 'import'): ParsedPatientsCsv {
  const records = parseCsvRecords(csvText);
  if (records.length === 0) {
    throw new HttpException(
      { code: IMPORT_ERROR.invalidCsv, message: 'The CSV is empty', traceId },
      400,
    );
  }

  const header = (records[0] as string[]).map((cell) => cell.trim().toLowerCase());
  for (const column of CSV_REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new HttpException(
        { code: IMPORT_ERROR.invalidCsv, message: `Missing required column: ${column}`, traceId },
        400,
      );
    }
  }
  const index = new Map<string, number>();
  for (const column of CSV_COLUMNS) {
    const position = header.indexOf(column);
    if (position >= 0) index.set(column, position);
  }
  const cell = (record: string[], column: string): string => {
    const position = index.get(column);
    if (position === undefined) return '';
    return (record[position] ?? '').trim();
  };

  const rows: PatientImportRow[] = [];
  const errors: PatientImportRowError[] = [];

  for (let position = 1; position < records.length; position += 1) {
    const record = records[position] as string[];
    const rowNumber = position + 1;
    const rowErrors: PatientImportRowError[] = [];
    const fail = (field: string, code: ImportRowErrorCode, message: string): void => {
      rowErrors.push({ rowNumber, field, code, message });
    };

    const personName = cell(record, 'person_name');
    if (personName === '') fail('person_name', IMPORT_ROW_ERROR.fieldRequired, 'person_name is required');

    const documentType = cell(record, 'document_type').toLowerCase();
    if (documentType === '') {
      fail('document_type', IMPORT_ROW_ERROR.fieldRequired, 'document_type is required');
    } else if (!(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      fail(
        'document_type',
        IMPORT_ROW_ERROR.invalidDocumentType,
        `document_type must be one of ${DOCUMENT_TYPES.join('|')}`,
      );
    }

    const documentNumber = cell(record, 'document_number');
    if (documentNumber === '') {
      fail('document_number', IMPORT_ROW_ERROR.fieldRequired, 'document_number is required');
    }

    const birthdate = cell(record, 'birthdate');
    if (birthdate !== '' && !isCalendarDate(birthdate)) {
      fail('birthdate', IMPORT_ROW_ERROR.invalidDate, 'birthdate must be a real YYYY-MM-DD date');
    }

    const phone = cell(record, 'phone');
    const rawOrgNodeId = cell(record, 'org_node_id');
    let orgNodeId: string | null = null;
    if (rawOrgNodeId !== '') {
      if (UUID_RE.test(rawOrgNodeId)) {
        orgNodeId = rawOrgNodeId;
      } else {
        fail('org_node_id', IMPORT_ROW_ERROR.invalidOrgNode, 'org_node_id must be a UUID');
      }
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    rows.push({
      rowNumber,
      personName,
      documentType,
      documentNumber,
      birthdate: birthdate === '' ? null : birthdate,
      phone: phone === '' ? null : phone,
      orgNodeId,
    });
  }

  return { rows, errors };
}

/** Quotes one CSV cell when it carries a separator, a quote or a newline. */
function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.split('"').join('""')}"`;
}

/** The downloadable errors CSV (`row,field,code,message`). */
export function buildErrorsCsv(errors: readonly PatientImportRowError[]): string {
  const lines = ['row,field,code,message'];
  for (const error of errors) {
    lines.push([String(error.rowNumber), error.field, error.code, error.message].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// ============ row shape ============

/** One import run as the API exposes it; `errorsCsv` is null when clean. */
export interface ImportJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly status: string;
  readonly rowsOk: number;
  readonly rowsError: number;
  /** Attachment id of the source CSV (object-storage metadata only). */
  readonly fileId: string | null;
  /** SHA-256 of the source CSV, the replay key of §5.4. */
  readonly fileSha256: string | null;
  /** Attachment id of the downloadable errors CSV, when the run had errors. */
  readonly errorsFileId: string | null;
  readonly errorsCsv: string | null;
  readonly createdAt: string | null;
}

function mapImportJob(
  row: Record<string, unknown>,
  fileSha256: string | null,
  errorsCsv: string | null,
): ImportJobRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    kind: readString(row.kind) ?? IMPORT_KIND_PATIENT_FILES_CSV,
    status: readString(row.status) ?? 'completed',
    rowsOk: toNumber(row.rows_ok),
    rowsError: toNumber(row.rows_error),
    fileId: readString(row.file_id) ?? null,
    fileSha256,
    errorsFileId: readString(row.errors_file_id) ?? null,
    errorsCsv,
    createdAt: toIso(row.created_at),
  };
}

/** Rehydrates the stored replay response (camelCase job record). */
function readStoredJob(value: unknown): ImportJobRecord | null {
  const record = asRecord(value);
  const id = readString(record.id);
  if (id === undefined || id === '') return null;
  return {
    id,
    tenantId: readString(record.tenantId) ?? '',
    kind: readString(record.kind) ?? IMPORT_KIND_PATIENT_FILES_CSV,
    status: readString(record.status) ?? 'completed',
    rowsOk: toNumber(record.rowsOk),
    rowsError: toNumber(record.rowsError),
    fileId: readString(record.fileId) ?? null,
    fileSha256: readString(record.fileSha256) ?? null,
    errorsFileId: readString(record.errorsFileId) ?? null,
    errorsCsv: readString(record.errorsCsv) ?? null,
    createdAt: readString(record.createdAt) ?? null,
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

async function loadFacts(actor: ActorContext, module = 'salud'): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null
      ? []
      : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await tenantHasModule(actor.client, actor.tenantId, module);
  return { membership, scopeSubtree, moduleActive };
}

interface AuthorizeOptions {
  readonly entity: string;
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
  const rolePermits = facts.membership !== null && rolePermitsAction(facts.membership.role, 'patient.write');
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
      attemptedAction: options.attemptedAction ?? 'patient.write',
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
    'import_job',
    entry.entityId,
    entry.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...entry.diff }),
    actor.ip,
  ]);
}

// ============ constraint mapping ============

/** SQLSTATE of a unique-constraint violation (a duplicate document). */
const SQLSTATE_UNIQUE_VIOLATION = '23505';
/** SQLSTATE of a foreign-key violation (a dangling sede reference). */
const SQLSTATE_FK_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// ============ SQL ============

const INSERT_SOURCE_ATTACHMENT_SQL = `INSERT INTO attachments
  (tenant_id, bucket_key, sha256, mime, size_bytes, uploaded_by)
VALUES ($1, $2, $3, 'text/csv', $4, $5)
RETURNING id`;

const INSERT_ERRORS_ATTACHMENT_SQL = INSERT_SOURCE_ATTACHMENT_SQL;

const INSERT_IMPORT_JOB_SQL = `INSERT INTO import_jobs
  (tenant_id, kind, file_id, status, rows_ok, rows_error, errors_file_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, tenant_id, kind, status, rows_ok, rows_error, file_id, errors_file_id, created_at`;

const SELECT_IMPORT_JOB_SQL = `SELECT j.id, j.tenant_id, j.kind, j.status, j.rows_ok, j.rows_error,
  j.file_id, j.errors_file_id, j.created_at, a.sha256 AS file_sha256
FROM import_jobs j
LEFT JOIN attachments a ON a.id = j.file_id
WHERE j.tenant_id = $1 AND j.id = $2
LIMIT 1`;

const INSERT_PATIENT_SQL = `INSERT INTO patient_files
  (tenant_id, org_node_id, person_name, document_type, document_number, birthdate, contacts, active)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, TRUE)
RETURNING id`;

const INSERT_PENDING_CONSENT_SQL = `INSERT INTO consents
  (tenant_id, patient_id, template_code, version, status)
VALUES ($1, $2, $3, $4, 'pending')`;

// Per-row isolation. The request already runs inside the tenant's transaction
// (the middleware wraps `/v1/*`), so a constraint violation raised by one row
// aborts that transaction: the savepoint is what lets the import count the row
// as an error and keep going (SQLSTATE 25P02 otherwise).
const ROW_SAVEPOINT = 'import_row';
const SAVEPOINT_SQL = `SAVEPOINT ${ROW_SAVEPOINT}`;
const RELEASE_SAVEPOINT_SQL = `RELEASE SAVEPOINT ${ROW_SAVEPOINT}`;
const ROLLBACK_TO_SAVEPOINT_SQL = `ROLLBACK TO SAVEPOINT ${ROW_SAVEPOINT}`;

const CLAIM_IDEMPOTENCY_SQL = `INSERT INTO idempotency_keys
  (tenant_id, key, request_hash, response, expires_at)
VALUES ($1, $2, $3, NULL, now() + ($4 || ' hours')::interval)
ON CONFLICT (tenant_id, key) DO NOTHING
RETURNING key`;
const SELECT_IDEMPOTENCY_SQL = `SELECT request_hash, response, (expires_at > now()) AS still_valid
FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 FOR UPDATE`;
const REFRESH_IDEMPOTENCY_SQL = `UPDATE idempotency_keys
SET request_hash = $3, response = NULL, created_at = now(), expires_at = now() + ($4 || ' hours')::interval
WHERE tenant_id = $1 AND key = $2`;
const FINALIZE_IDEMPOTENCY_SQL = `UPDATE idempotency_keys
SET response = $3::jsonb
WHERE tenant_id = $1 AND key = $2`;
const DELETE_IDEMPOTENCY_SQL = `DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`;
const SELECT_STORED_RESPONSE_SQL = `SELECT response FROM idempotency_keys
WHERE tenant_id = $1 AND key = $2 LIMIT 1`;

/** §5.4 replay key: the importer kind plus the file hash. */
export function importIdempotencyKey(fileSha256: string): string {
  return `import:${IMPORT_KIND_PATIENT_FILES_CSV}:${fileSha256}`;
}

// ============ request parsing ============

interface PatientImportInput {
  readonly csvText: string;
  readonly orgNodeId: string;
}

function parseImportBody(body: unknown, traceId: string): PatientImportInput {
  const record = asRecord(body);
  const csvText = readString(record.csv) ?? '';
  if (csvText.trim() === '') {
    throw importError(IMPORT_ERROR.csvRequired, 'csv must be a non-empty CSV text', 400, traceId);
  }
  const orgNodeId = readString(record.orgNodeId)?.trim() ?? '';
  if (!UUID_RE.test(orgNodeId)) {
    throw importError(IMPORT_ERROR.invalidOrgNode, 'Invalid UUID in field: orgNodeId', 400, traceId);
  }
  return { csvText, orgNodeId };
}

/** Reads the header key; a critical POST without it is rejected (§5.1). */
function requireIdempotencyKey(raw: string | undefined, traceId: string): string {
  const key = raw?.trim() ?? '';
  if (key === '') {
    throw importError(
      IMPORT_ERROR.idempotencyKeyRequired,
      'An Idempotency-Key header is required',
      400,
      traceId,
    );
  }
  return key;
}

// ============ use cases ============

/**
 * Imports a patients CSV: validates every row, inserts the valid ones with a
 * pending initial consent, records the job and returns its contract with the
 * errors CSV inline. Re-uploading the same bytes replays the original job.
 */
export async function importPatients(
  actor: ActorContext,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<ImportJobRecord> {
  const headerKey = requireIdempotencyKey(idempotencyKey, actor.traceId);
  const input = parseImportBody(body, actor.traceId);
  const parsed = parsePatientsCsv(input.csvText, actor.traceId);
  const fileSha256 = sha256Hex(input.csvText);

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'import_job',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'import.patients_csv',
  });

  const storeKey = importIdempotencyKey(fileSha256);
  const requestHash = sha256Hex(
    JSON.stringify({ kind: IMPORT_KIND_PATIENT_FILES_CSV, orgNodeId: input.orgNodeId, fileSha256 }),
  );

  // Idempotency gate: claim the hash first so two concurrent uploads of the same
  // file cannot both import. A later failure deletes the claim, so a committed
  // transaction never leaves a key with a null response.
  const claimed = await actor.client.query(CLAIM_IDEMPOTENCY_SQL, [
    actor.tenantId,
    storeKey,
    requestHash,
    String(IMPORT_IDEMPOTENCY_WINDOW_HOURS),
  ]);
  let ownsKey = readRows(claimed).length > 0;

  try {
    if (!ownsKey) {
      const existing = await actor.client.query(SELECT_IDEMPOTENCY_SQL, [actor.tenantId, storeKey]);
      const row = readRows(existing)[0];
      if (row !== undefined && readBoolean(row.still_valid)) {
        const storedHash = readString(row.request_hash) ?? '';
        if (storedHash !== requestHash) {
          throw importError(
            IMPORT_ERROR.idempotencyConflict,
            'The same file was already imported for a different sede',
            409,
            actor.traceId,
          );
        }
        const replayed = readStoredJob(row.response);
        if (replayed !== null) return replayed;
      }
      await actor.client.query(REFRESH_IDEMPOTENCY_SQL, [
        actor.tenantId,
        storeKey,
        requestHash,
        String(IMPORT_IDEMPOTENCY_WINDOW_HOURS),
      ]);
      ownsKey = true;
    }

    const rowErrors: PatientImportRowError[] = [...parsed.errors];
    const seenDocuments = new Set<string>();
    let rowsOk = 0;

    for (const row of parsed.rows) {
      if (seenDocuments.has(row.documentNumber)) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          field: 'document_number',
          code: IMPORT_ROW_ERROR.documentDuplicate,
          message: `document_number ${row.documentNumber} is repeated inside the file`,
        });
        continue;
      }
      seenDocuments.add(row.documentNumber);

      const targetOrgNodeId = row.orgNodeId ?? input.orgNodeId;
      if (!facts.scopeSubtree.includes(targetOrgNodeId)) {
        rowErrors.push({
          rowNumber: row.rowNumber,
          field: 'org_node_id',
          code: IMPORT_ROW_ERROR.orgNodeOutOfScope,
          message: `org_node_id ${targetOrgNodeId} is outside the caller scope`,
        });
        continue;
      }

      await actor.client.query(SAVEPOINT_SQL);
      try {
        const inserted = await actor.client.query(INSERT_PATIENT_SQL, [
          actor.tenantId,
          targetOrgNodeId,
          row.personName,
          row.documentType,
          row.documentNumber,
          row.birthdate,
          JSON.stringify(row.phone === null ? {} : { phone: row.phone }),
        ]);
        const patientId = readString(readRows(inserted)[0]?.id);
        if (patientId === undefined) {
          throw importError(IMPORT_ERROR.writeFailed, 'Patient insert returned no row', 500, actor.traceId);
        }
        // §5.4: the initial consent is created as `pending` for every import.
        await actor.client.query(INSERT_PENDING_CONSENT_SQL, [
          actor.tenantId,
          patientId,
          IMPORT_CONSENT_TEMPLATE,
          IMPORT_CONSENT_VERSION,
        ]);
        await actor.client.query(RELEASE_SAVEPOINT_SQL);
        rowsOk += 1;
      } catch (error) {
        const state = sqlState(error);
        if (state === SQLSTATE_UNIQUE_VIOLATION) {
          await actor.client.query(ROLLBACK_TO_SAVEPOINT_SQL);
          rowErrors.push({
            rowNumber: row.rowNumber,
            field: 'document_number',
            code: IMPORT_ROW_ERROR.documentDuplicate,
            message: `document_number ${row.documentNumber} already exists`,
          });
          continue;
        }
        if (state === SQLSTATE_FK_VIOLATION) {
          await actor.client.query(ROLLBACK_TO_SAVEPOINT_SQL);
          rowErrors.push({
            rowNumber: row.rowNumber,
            field: 'org_node_id',
            code: IMPORT_ROW_ERROR.invalidOrgNode,
            message: `org_node_id ${targetOrgNodeId} does not exist`,
          });
          continue;
        }
        throw error;
      }
    }

    // Parse-time errors are collected in one pass and insert-time errors are
    // appended while the rows are written, so sort once before serializing: the
    // downloadable file reads in source order, not in pass order.
    rowErrors.sort((left, right) => left.rowNumber - right.rowNumber);
    const errorsCsv = rowErrors.length === 0 ? null : buildErrorsCsv(rowErrors);

    const sourceAttachment = await actor.client.query(INSERT_SOURCE_ATTACHMENT_SQL, [
      actor.tenantId,
      `imports/${IMPORT_KIND_PATIENT_FILES_CSV}/${fileSha256}.csv`,
      fileSha256,
      Buffer.byteLength(input.csvText, 'utf8'),
      actor.userId,
    ]);
    const fileId = readString(readRows(sourceAttachment)[0]?.id) ?? null;

    let errorsFileId: string | null = null;
    if (errorsCsv !== null) {
      const errorsAttachment = await actor.client.query(INSERT_ERRORS_ATTACHMENT_SQL, [
        actor.tenantId,
        `imports/${IMPORT_KIND_PATIENT_FILES_CSV}/${fileSha256}/errors.csv`,
        sha256Hex(errorsCsv),
        Buffer.byteLength(errorsCsv, 'utf8'),
        actor.userId,
      ]);
      errorsFileId = readString(readRows(errorsAttachment)[0]?.id) ?? null;
    }

    const jobResult = await actor.client.query(INSERT_IMPORT_JOB_SQL, [
      actor.tenantId,
      IMPORT_KIND_PATIENT_FILES_CSV,
      fileId,
      'completed',
      rowsOk,
      rowErrors.length,
      errorsFileId,
    ]);
    const jobRow = readRows(jobResult)[0];
    if (jobRow === undefined) {
      throw importError(IMPORT_ERROR.writeFailed, 'Import job insert returned no row', 500, actor.traceId);
    }
    const job = mapImportJob(jobRow, fileSha256, errorsCsv);

    await writeAudit(actor, membership, {
      action: 'import.completed',
      entityId: job.id,
      orgNodeId: input.orgNodeId,
      diff: {
        idempotencyKey: headerKey,
        kind: IMPORT_KIND_PATIENT_FILES_CSV,
        fileSha256,
        rowsOk,
        rowsError: rowErrors.length,
        errorsFileId,
      },
    });

    await actor.client.query(FINALIZE_IDEMPOTENCY_SQL, [
      actor.tenantId,
      storeKey,
      JSON.stringify(job),
    ]);
    return job;
  } catch (error) {
    if (ownsKey) {
      // Free the claim so the retry is not answered with a null response. A 5xx
      // path rolls the whole transaction back anyway; a 4xx path commits.
      try {
        await actor.client.query(DELETE_IDEMPOTENCY_SQL, [actor.tenantId, storeKey]);
      } catch {
        // best effort: the original failure is the one that must surface
      }
    }
    throw error;
  }
}

/**
 * Reads one import job, including the downloadable errors CSV. The errors text
 * lives in the §5.1 replay response, so it is recovered through the source
 * file hash carried by the `attachments` join; a job whose source attachment is
 * gone still returns its counts and `errorsFileId`.
 */
export async function getImportJob(actor: ActorContext, jobId: string): Promise<ImportJobRecord> {
  const id = requireUuidParam(jobId, 'import job id', actor.traceId);
  const result = await actor.client.query(SELECT_IMPORT_JOB_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound('import_job', actor.traceId);

  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'import_job',
    entityId: id,
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'import.read',
  });

  const fileSha256 = readString(row.file_sha256) ?? null;
  let errorsCsv: string | null = null;
  if (fileSha256 !== null) {
    const stored = await actor.client.query(SELECT_STORED_RESPONSE_SQL, [
      actor.tenantId,
      importIdempotencyKey(fileSha256),
    ]);
    const response = readRows(stored)[0]?.response;
    if (response !== undefined && response !== null) {
      errorsCsv = readString(asRecord(response).errorsCsv) ?? null;
    }
  }
  return mapImportJob(row, fileSha256, errorsCsv);
}
