// Obras CSV importers — workers and equipment (bases-consolidadas-v1.md §2.4,
// §3.1, §3.4, §4.4).
//
// Deliberately plain, like `obras.service.ts` and `resources.service.ts`: no
// decorators, because `npm test` loads the sources through Node's strip-only
// TypeScript (which rejects decorator syntax). The HTTP skin lives in
// `import.controller.ts` and stays thin; this module owns each use case:
//   1. validate the body ({csv, orgNodeId}) and parse the CSV into rows plus
//      per-row errors, so one bad line never aborts the whole file;
//   2. build the guard facts (membership, org-node subtree, tenant module) and
//      evaluate the central rule through `canActivate` — which audits every
//      denial as `access.denied` — refusing on denial;
//   3. insert every valid row inside its own SAVEPOINT, so a per-row failure is
//      counted as a row error instead of aborting the run (a bare `catch`
//      around the INSERT is not enough: in Postgres the failed statement
//      poisons the whole request transaction — SQLSTATE 25P02 — and every later
//      statement fails until the savepoint is rolled back);
//   4. write the `import_jobs` contract row (`rows_ok`, `rows_error`, the
//      downloadable errors CSV) and one `audit_log` row.
//
// Idempotency contract (§5.4 «toda importación es idempotente por hash del
// archivo»): the SHA-256 of the CSV text is the replay key, so a second upload
// of the same bytes returns the original job — errors CSV included — instead of
// importing twice, even under a different `Idempotency-Key`. The same bytes
// aimed at a different org node is a 409, because that is a different import
// intent rather than a retry. The required `Idempotency-Key` header is
// validated and recorded in the audit diff.
//
// Business idempotency, on top of the file hash: `users` is UNIQUE
// `(tenant_id, email)` and `assets` is UNIQUE `(tenant_id, code)`, so a worker
// or equipment unit that already exists is reported as a row error instead of
// creating a duplicate. Both importers therefore behave as «idempotent by
// business key» even for a different file that names the same key.
//
// Schema note (load-bearing, mirrors `salud/import.service.ts`): `import_jobs`
// (migration 001) has no file-hash and no content column, and the source/errors
// CSVs are object-storage objects (`attachments.bucket_key`) that no MVP1
// component uploads. The run therefore persists metadata only — the CSV text in
// `attachments` by hash, the job row in `import_jobs`, and the full job
// response (which carries `errorsCsv`) in `idempotency_keys.response` JSONB.
// `getImportJob` reads the errors CSV back through the source attachment hash,
// so the job detail stays reproducible without a new column.
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import { OBRA_MODULE, type ObraActorContext, type ObraClient } from './obras.service.ts';

export type { ObraActorContext, ObraClient };

/** `import_jobs.kind` for the workers CSV importer. */
export const IMPORT_KIND_WORKERS_CSV = 'workers_csv';

/** `import_jobs.kind` for the equipment CSV importer. */
export const IMPORT_KIND_ASSETS_CSV = 'assets_csv';

/** Header carrying the client idempotency key. */
export const IMPORT_IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Key window kept in `idempotency_keys` (24 h). */
export const IMPORT_IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * Construction roles a worker row may carry: the five roles the seed assigns a
 * membership in the construction vertical (`gerente`, `jefe_obra`, `almacen`,
 * `capataz`, `trabajador`). A row naming any other role is a row error.
 */
export const CONSTRUCTION_ROLES = [
  'gerente',
  'jefe_obra',
  'almacen',
  'capataz',
  'trabajador',
] as const;
export type ConstructionRole = (typeof CONSTRUCTION_ROLES)[number];

/** Rows a job detail may carry; the run itself is bounded by HTTP. */
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
  invalidEmail: 'import.invalid_email',
  invalidRole: 'import.invalid_role',
  invalidOrgNode: 'import.invalid_org_node',
  invalidHorometer: 'import.invalid_horometer',
  orgNodeOutOfScope: 'import.org_node_out_of_scope',
  workerDuplicate: 'import.worker_duplicate',
  assetDuplicate: 'import.asset_duplicate',
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
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

/** SHA-256 hex digest, the file-hash replay key. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Rejects a path param that is not a UUID before any query runs. */
function requireUuidParam(value: string, label: string, traceId: string): string {
  if (!UUID_RE.test(value?.trim() ?? '')) throw badRequest(`Invalid ${label}`, traceId);
  return value.trim();
}

// ============ CSV parsing ============

/** One per-row validation failure; the unit of the downloadable errors file. */
export interface ImportRowError {
  /** 1-based line in the source file, header included. */
  readonly rowNumber: number;
  readonly field: string;
  readonly code: ImportRowErrorCode;
  readonly message: string;
}

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

interface CsvReader {
  readonly index: Map<string, number>;
  readonly cell: (record: string[], column: string) => string;
}

/**
 * Validates the header (required columns present) and builds a by-name cell
 * reader. Unknown columns are ignored. A structural problem throws a 400.
 */
function openCsv(csvText: string, required: readonly string[], traceId: string): { records: string[][]; reader: CsvReader } {
  const records = parseCsvRecords(csvText);
  if (records.length === 0) {
    throw importError(IMPORT_ERROR.invalidCsv, 'The CSV is empty', 400, traceId);
  }
  const header = (records[0] as string[]).map((cell) => cell.trim().toLowerCase());
  for (const column of required) {
    if (!header.includes(column)) {
      throw importError(IMPORT_ERROR.invalidCsv, `Missing required column: ${column}`, 400, traceId);
    }
  }
  const index = new Map<string, number>();
  header.forEach((column, position) => {
    if (!index.has(column)) index.set(column, position);
  });
  const cell = (record: string[], column: string): string => {
    const position = index.get(column);
    if (position === undefined) return '';
    return (record[position] ?? '').trim();
  };
  return { records, reader: { index, cell } };
}

/** Quotes one CSV cell when it carries a separator, a quote or a newline. */
function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.split('"').join('""')}"`;
}

/** The downloadable errors CSV (`row,field,code,message`). */
export function buildErrorsCsv(errors: readonly ImportRowError[]): string {
  const lines = ['row,field,code,message'];
  for (const error of errors) {
    lines.push([String(error.rowNumber), error.field, error.code, error.message].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// ============ workers CSV ============

/** One validated workers row, ready to become a `users` + `memberships` pair. */
export interface WorkerImportRow {
  readonly rowNumber: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly role: ConstructionRole;
  /** Per-row org override; null means «use the request `orgNodeId`». */
  readonly orgNodeId: string | null;
}

export interface ParsedWorkersCsv {
  readonly rows: readonly WorkerImportRow[];
  readonly errors: readonly ImportRowError[];
}

const WORKERS_REQUIRED_COLUMNS = ['name', 'email', 'role'] as const;

/**
 * Parses and validates the workers CSV (`name,email,phone,role,org_node_id`).
 * Structural problems throw a 400; per-row problems are returned as `errors`
 * and exclude only that row.
 */
export function parseWorkersCsv(csvText: string, traceId = 'import'): ParsedWorkersCsv {
  const { records, reader } = openCsv(csvText, WORKERS_REQUIRED_COLUMNS, traceId);
  const rows: WorkerImportRow[] = [];
  const errors: ImportRowError[] = [];

  for (let position = 1; position < records.length; position += 1) {
    const record = records[position] as string[];
    const rowNumber = position + 1;
    const rowErrors: ImportRowError[] = [];
    const fail = (field: string, code: ImportRowErrorCode, message: string): void => {
      rowErrors.push({ rowNumber, field, code, message });
    };

    const name = reader.cell(record, 'name');
    if (name === '') fail('name', IMPORT_ROW_ERROR.fieldRequired, 'name is required');

    const email = reader.cell(record, 'email').toLowerCase();
    if (email === '') {
      fail('email', IMPORT_ROW_ERROR.fieldRequired, 'email is required');
    } else if (!EMAIL_RE.test(email)) {
      fail('email', IMPORT_ROW_ERROR.invalidEmail, 'email must be a valid address');
    }

    const rawRole = reader.cell(record, 'role').toLowerCase();
    if (rawRole === '') {
      fail('role', IMPORT_ROW_ERROR.fieldRequired, 'role is required');
    } else if (!(CONSTRUCTION_ROLES as readonly string[]).includes(rawRole)) {
      fail(
        'role',
        IMPORT_ROW_ERROR.invalidRole,
        `role must be one of ${CONSTRUCTION_ROLES.join('|')}`,
      );
    }

    const phone = reader.cell(record, 'phone');
    const rawOrgNodeId = reader.cell(record, 'org_node_id');
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
      name,
      email,
      phone: phone === '' ? null : phone,
      role: rawRole as ConstructionRole,
      orgNodeId,
    });
  }

  return { rows, errors };
}

// ============ assets CSV ============

/** One validated equipment row, ready to become an `assets` row. */
export interface AssetImportRow {
  readonly rowNumber: number;
  readonly code: string;
  readonly kind: string;
  readonly serial: string;
  /** Optional initial horometer reading; null when the row omits it. */
  readonly horometer: number | null;
  readonly orgNodeId: string | null;
}

export interface ParsedAssetsCsv {
  readonly rows: readonly AssetImportRow[];
  readonly errors: readonly ImportRowError[];
}

const ASSETS_REQUIRED_COLUMNS = ['code', 'kind', 'serial'] as const;

/**
 * Parses and validates the equipment CSV
 * (`code,kind,serial,horometer,org_node_id`). `horometer` and `org_node_id` are
 * optional; a blank horometer means «no initial reading».
 */
export function parseAssetsCsv(csvText: string, traceId = 'import'): ParsedAssetsCsv {
  const { records, reader } = openCsv(csvText, ASSETS_REQUIRED_COLUMNS, traceId);
  const rows: AssetImportRow[] = [];
  const errors: ImportRowError[] = [];

  for (let position = 1; position < records.length; position += 1) {
    const record = records[position] as string[];
    const rowNumber = position + 1;
    const rowErrors: ImportRowError[] = [];
    const fail = (field: string, code: ImportRowErrorCode, message: string): void => {
      rowErrors.push({ rowNumber, field, code, message });
    };

    const code = reader.cell(record, 'code');
    if (code === '') fail('code', IMPORT_ROW_ERROR.fieldRequired, 'code is required');

    const kind = reader.cell(record, 'kind');
    if (kind === '') fail('kind', IMPORT_ROW_ERROR.fieldRequired, 'kind is required');

    const serial = reader.cell(record, 'serial');
    if (serial === '') fail('serial', IMPORT_ROW_ERROR.fieldRequired, 'serial is required');

    const rawHorometer = reader.cell(record, 'horometer');
    let horometer: number | null = null;
    if (rawHorometer !== '') {
      const parsed = Number(rawHorometer);
      if (!Number.isFinite(parsed) || parsed < 0) {
        fail('horometer', IMPORT_ROW_ERROR.invalidHorometer, 'horometer must be a number >= 0');
      } else {
        horometer = parsed;
      }
    }

    const rawOrgNodeId = reader.cell(record, 'org_node_id');
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
    rows.push({ rowNumber, code, kind, serial, horometer, orgNodeId });
  }

  return { rows, errors };
}

// ============ job shape ============

/** One import run as the API exposes it; `errorsCsv` is null when clean. */
export interface ImportJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly status: string;
  readonly rowsOk: number;
  readonly rowsError: number;
  readonly fileId: string | null;
  readonly fileSha256: string | null;
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
    kind: readString(row.kind) ?? '',
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
    kind: readString(record.kind) ?? '',
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
  readonly action: ActionCode;
  readonly entity: string;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly attemptedAction?: string;
}

/** Runs the central rule and audits any denial before throwing 403. */
async function authorize(
  actor: ObraActorContext,
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
    stateAllows: true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: options.entity,
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

/** Appends one row per accepted write; the trace id rides in `diff`. */
async function writeAudit(
  actor: ObraActorContext,
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

/** SQLSTATE of a unique-constraint violation (a duplicate business key). */
const SQLSTATE_UNIQUE_VIOLATION = '23505';
/** SQLSTATE of a foreign-key violation (a dangling org-node reference). */
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

// New users land inactive (`active = FALSE`): importing a roster is not the
// same as enabling a login, so an administrator activates the account on its
// first sign-in. The membership, however, is written active: the role and the
// org node are already known and the guard reads `user_active` from the row.
const INSERT_WORKER_USER_SQL = `INSERT INTO users
  (tenant_id, name, email, phone, active)
VALUES ($1, $2, $3, $4, FALSE)
RETURNING id`;
const INSERT_WORKER_MEMBERSHIP_SQL = `INSERT INTO memberships
  (user_id, tenant_id, org_node_id, role, scopes, active)
VALUES ($1, $2, $3, $4, '{}', TRUE)`;

const INSERT_ASSET_SQL = `INSERT INTO assets
  (tenant_id, org_node_id, code, kind, serial, status, current_site_id)
VALUES ($1, $2, $3, $4, $5, 'available', NULL)
RETURNING id`;
const INSERT_ASSET_READING_SQL = `INSERT INTO asset_readings
  (tenant_id, asset_id, kind, value, source)
VALUES ($1, $2, $3, $4, 'import')`;

// Per-row isolation. The request already runs inside the tenant's transaction
// (the middleware wraps `/v1/*`), so a constraint violation raised by one row
// aborts that transaction: the savepoint is what lets the importer count the
// row as an error and keep going (SQLSTATE 25P02 otherwise).
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

/** Replay key: the importer kind plus the file hash. */
export function importIdempotencyKey(kind: string, fileSha256: string): string {
  return `import:${kind}:${fileSha256}`;
}

// ============ request parsing ============

interface ImportInput {
  readonly csvText: string;
  readonly orgNodeId: string;
}

function parseImportBody(body: unknown, traceId: string): ImportInput {
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

/** Reads the header key; a critical POST without it is rejected. */
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

// ============ idempotency + row loop shared by both importers ============

interface ImportRun<TRow> {
  readonly kind: string;
  readonly input: ImportInput;
  readonly fileSha256: string;
  readonly parsedRows: readonly TRow[];
  readonly parseErrors: readonly ImportRowError[];
  readonly authorizeAction: ActionCode;
  readonly attemptedAction: string;
  /** Business key of one row; a repeat inside the file is a row error. */
  readonly keyOf: (row: TRow) => string;
  readonly duplicateField: string;
  readonly duplicateCode: ImportRowErrorCode;
  /** Writes one row inside an open savepoint; returns true when it wrote. */
  readonly writeRow: (
    actor: ObraActorContext,
    scopeSubtree: readonly string[],
    row: TRow,
    fail: (field: string, code: ImportRowErrorCode, message: string) => void,
  ) => Promise<boolean>;
}

/**
 * The shared importer core: idempotency gate, per-row savepoint loop, job row,
 * error CSV, audit and replay finalize. `writeRow` owns the row-specific SQL;
 * a thrown unique/FK violation is mapped to the importer's configured row
 * error, and an in-file duplicate key is caught before the insert runs.
 */
async function runImport<TRow>(
  actor: ObraActorContext,
  headerKey: string,
  run: ImportRun<TRow>,
): Promise<ImportJobRecord> {
  const { input, kind, fileSha256 } = run;
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    action: run.authorizeAction,
    entity: 'import_job',
    orgNodeId: input.orgNodeId,
    attemptedAction: run.attemptedAction,
  });

  const storeKey = importIdempotencyKey(kind, fileSha256);
  const requestHash = sha256Hex(JSON.stringify({ kind, orgNodeId: input.orgNodeId, fileSha256 }));

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
            'The same file was already imported for a different org node',
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

    const rowErrors: ImportRowError[] = [...run.parseErrors];
    const seenKeys = new Set<string>();
    let rowsOk = 0;

    for (const row of run.parsedRows) {
      const rowNumber = (row as { rowNumber: number }).rowNumber;
      const fail = (field: string, code: ImportRowErrorCode, message: string): void => {
        rowErrors.push({ rowNumber, field, code, message });
      };

      // In-file duplicate business key: the first row wins, the repeat is a row
      // error and never reaches the INSERT.
      const key = run.keyOf(row);
      if (seenKeys.has(key)) {
        fail(run.duplicateField, run.duplicateCode, `${key} is repeated inside the file`);
        continue;
      }
      seenKeys.add(key);

      await actor.client.query(SAVEPOINT_SQL);
      try {
        const wrote = await run.writeRow(actor, facts.scopeSubtree, row, fail);
        await actor.client.query(RELEASE_SAVEPOINT_SQL);
        if (wrote) rowsOk += 1;
      } catch (error) {
        const state = sqlState(error);
        if (state === SQLSTATE_UNIQUE_VIOLATION) {
          await actor.client.query(ROLLBACK_TO_SAVEPOINT_SQL);
          fail(run.duplicateField, run.duplicateCode, 'the business key already exists in the tenant');
          continue;
        }
        if (state === SQLSTATE_FK_VIOLATION) {
          await actor.client.query(ROLLBACK_TO_SAVEPOINT_SQL);
          fail('org_node_id', IMPORT_ROW_ERROR.invalidOrgNode, 'org_node_id does not exist');
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
      `imports/${kind}/${fileSha256}.csv`,
      fileSha256,
      Buffer.byteLength(input.csvText, 'utf8'),
      actor.userId,
    ]);
    const fileId = readString(readRows(sourceAttachment)[0]?.id) ?? null;

    let errorsFileId: string | null = null;
    if (errorsCsv !== null) {
      const errorsAttachment = await actor.client.query(INSERT_ERRORS_ATTACHMENT_SQL, [
        actor.tenantId,
        `imports/${kind}/${fileSha256}/errors.csv`,
        sha256Hex(errorsCsv),
        Buffer.byteLength(errorsCsv, 'utf8'),
        actor.userId,
      ]);
      errorsFileId = readString(readRows(errorsAttachment)[0]?.id) ?? null;
    }

    const jobResult = await actor.client.query(INSERT_IMPORT_JOB_SQL, [
      actor.tenantId,
      kind,
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
        kind,
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

// ============ use cases ============

/**
 * Imports a workers CSV: creates an inactive `users` row plus its `memberships`
 * row per valid line, records the job and returns its contract with the errors
 * CSV inline. Re-uploading the same bytes replays the original job; a worker
 * whose email already exists in the tenant is a row error.
 */
export async function importWorkers(
  actor: ObraActorContext,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<ImportJobRecord> {
  const headerKey = requireIdempotencyKey(idempotencyKey, actor.traceId);
  const input = parseImportBody(body, actor.traceId);
  const parsed = parseWorkersCsv(input.csvText, actor.traceId);
  const fileSha256 = sha256Hex(input.csvText);

  return runImport<WorkerImportRow>(actor, headerKey, {
    kind: IMPORT_KIND_WORKERS_CSV,
    input,
    fileSha256,
    parsedRows: parsed.rows,
    parseErrors: parsed.errors,
    authorizeAction: 'assignment.write',
    attemptedAction: 'import.workers_csv',
    keyOf: (row) => row.email,
    duplicateField: 'email',
    duplicateCode: IMPORT_ROW_ERROR.workerDuplicate,
    writeRow: async (act, scopeSubtree, row, fail): Promise<boolean> => {
      const targetOrgNodeId = row.orgNodeId ?? input.orgNodeId;
      if (!scopeSubtree.includes(targetOrgNodeId)) {
        fail(
          'org_node_id',
          IMPORT_ROW_ERROR.orgNodeOutOfScope,
          `org_node_id ${targetOrgNodeId} is outside the caller scope`,
        );
        return false;
      }

      const inserted = await act.client.query(INSERT_WORKER_USER_SQL, [
        act.tenantId,
        row.name,
        row.email,
        row.phone,
      ]);
      const userId = readString(readRows(inserted)[0]?.id);
      if (userId === undefined) {
        throw importError(IMPORT_ERROR.writeFailed, 'User insert returned no row', 500, act.traceId);
      }
      await act.client.query(INSERT_WORKER_MEMBERSHIP_SQL, [
        userId,
        act.tenantId,
        targetOrgNodeId,
        row.role,
      ]);
      return true;
    },
  });
}

/**
 * Imports an equipment CSV: creates an `available` asset per valid line and, when
 * the row carries a horometer, its initial `asset_readings` row. Re-uploading the
 * same bytes replays the original job; a code already registered in the tenant is
 * a row error.
 */
export async function importAssets(
  actor: ObraActorContext,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<ImportJobRecord> {
  const headerKey = requireIdempotencyKey(idempotencyKey, actor.traceId);
  const input = parseImportBody(body, actor.traceId);
  const parsed = parseAssetsCsv(input.csvText, actor.traceId);
  const fileSha256 = sha256Hex(input.csvText);

  return runImport<AssetImportRow>(actor, headerKey, {
    kind: IMPORT_KIND_ASSETS_CSV,
    input,
    fileSha256,
    parsedRows: parsed.rows,
    parseErrors: parsed.errors,
    authorizeAction: 'site.write',
    attemptedAction: 'import.assets_csv',
    keyOf: (row) => row.code,
    duplicateField: 'code',
    duplicateCode: IMPORT_ROW_ERROR.assetDuplicate,
    writeRow: async (act, scopeSubtree, row, fail): Promise<boolean> => {
      const targetOrgNodeId = row.orgNodeId ?? input.orgNodeId;
      if (!scopeSubtree.includes(targetOrgNodeId)) {
        fail(
          'org_node_id',
          IMPORT_ROW_ERROR.orgNodeOutOfScope,
          `org_node_id ${targetOrgNodeId} is outside the caller scope`,
        );
        return false;
      }

      const inserted = await act.client.query(INSERT_ASSET_SQL, [
        act.tenantId,
        targetOrgNodeId,
        row.code,
        row.kind,
        row.serial,
      ]);
      const assetId = readString(readRows(inserted)[0]?.id);
      if (assetId === undefined) {
        throw importError(IMPORT_ERROR.writeFailed, 'Asset insert returned no row', 500, act.traceId);
      }
      if (row.horometer !== null) {
        await act.client.query(INSERT_ASSET_READING_SQL, [
          act.tenantId,
          assetId,
          'horometro',
          row.horometer,
        ]);
      }
      return true;
    },
  });
}

/**
 * Reads one import job, including the downloadable errors CSV. The errors text
 * lives in the replay response, so it is recovered through the source file hash
 * carried by the `attachments` join; a job whose source attachment is gone still
 * returns its counts and `errorsFileId`.
 */
export async function getImportJob(actor: ObraActorContext, jobId: string): Promise<ImportJobRecord> {
  const id = requireUuidParam(jobId, 'import job id', actor.traceId);
  const result = await actor.client.query(SELECT_IMPORT_JOB_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound('import_job', actor.traceId);

  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    action: 'site.read',
    entity: 'import_job',
    entityId: id,
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'import.read',
  });

  const kind = readString(row.kind) ?? '';
  const fileSha256 = readString(row.file_sha256) ?? null;
  let errorsCsv: string | null = null;
  if (fileSha256 !== null && kind !== '') {
    const stored = await actor.client.query(SELECT_STORED_RESPONSE_SQL, [
      actor.tenantId,
      importIdempotencyKey(kind, fileSha256),
    ]);
    const response = readRows(stored)[0]?.response;
    if (response !== undefined && response !== null) {
      errorsCsv = readString(asRecord(response).errorsCsv) ?? null;
    }
  }
  return mapImportJob(row, fileSha256, errorsCsv);
}
