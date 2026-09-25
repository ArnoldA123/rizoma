// Signed file service — S3 presigned upload/download (H2, bases §4.5).
//
// Deliberately plain, like `salud.service.ts` and `consents.service.ts`: no
// decorators, because `npm test` loads the sources through Node's strip-only
// TypeScript, which rejects decorator syntax. The HTTP skin lives in
// `files.controller.ts` and stays thin; this module owns the whole use case:
//   1. validate the upload request (closed module list, MIME allow-list,
//      size cap) or the download target (UUID, canonical key, tenant match);
//   2. build the guard facts (membership, org-node subtree, tenant module) and
//      evaluate the central rule through `canActivate` — which audits every
//      denial as `access.denied` — refusing on denial;
//   3. run tenant-scoped parameterized SQL (RLS already bound the request
//      transaction), presign the URL (≤5 min, never permanent) and append one
//      `audit_log` row per operation.
//
// Key discipline: `POST /v1/files/request-upload` computes the canonical key
// with `buildObjectKey` and registers the `attachments` row before signing the
// PUT, so an upload URL never exists for an untracked object. `GET
// /v1/files/:id/download` re-parses the stored key with `parseObjectKey` and
// fails closed when the key is not canonical or names another tenant — legacy
// non-canonical keys stay reachable through their owning verticals, not here.
//
// Guard mapping: `attachments` carries no org node, so the scope term is the
// membership node itself (the list-read pattern of `salud.service.ts`) and the
// role term comes from the module that owns the key:
//
//   salud → patient.read / patient.write, obras/campo → site.read /
//   attendance.mark, inventario → site.read / stock.consume, facturacion →
//   invoice.issue, builder → site.read / site.write, everything else →
//   agenda.read / appointment.write.
//
// The S3 binding is resolved per call from the process env with synthetic
// local defaults (`resolveS3Config`); tests inject `overrides.s3` instead.
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import {
  FILE_MODULES,
  SIGNED_URL_TTL_SECONDS,
  buildObjectKey,
  parseObjectKey,
  type FileModule,
} from './paths.ts';
import {
  presignGetUrl,
  presignPutUrl,
  resolveS3Config,
  type S3Config,
} from './s3.ts';
import type { ActorContext, SaludClient } from '../salud/salud.service.ts';

/** Largest object the service signs a PUT for (25 MiB, mirrors contracts). */
export const FILE_SIZE_LIMIT_BYTES = 25_000_000;

/**
 * MIME types the service signs uploads for: documents and field photos. The
 * browser PUT sends the declared type unsigned (only `host` is signed), so the
 * allow-list is enforced here, before any URL is minted.
 */
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/mpeg',
  'audio/mp4',
  'video/mp4',
] as const;

/** Reason codes this slice exposes in the error envelope. */
export const FILE_REASON = {
  unsupportedKey: 'file.unsupported_key',
  tenantMismatch: 'file.tenant_mismatch',
} as const;

/** Guard actions per module: `{read}` gates download, `{write}` upload. */
interface ModuleActions {
  readonly read: ActionCode;
  readonly write: ActionCode;
}

const MODULE_ACTIONS: Record<FileModule, ModuleActions> = {
  'crm-core': { read: 'agenda.read', write: 'appointment.write' },
  salud: { read: 'patient.read', write: 'patient.write' },
  obras: { read: 'site.read', write: 'attendance.mark' },
  inventario: { read: 'site.read', write: 'stock.consume' },
  asistencia: { read: 'attendance.mark', write: 'attendance.mark' },
  facturacion: { read: 'invoice.issue', write: 'invoice.issue' },
  reportes: { read: 'agenda.read', write: 'appointment.write' },
  builder: { read: 'site.read', write: 'site.write' },
  notify: { read: 'agenda.read', write: 'appointment.write' },
  campo: { read: 'site.read', write: 'attendance.mark' },
};

// ============ error envelope ============

/** 400 envelope for a body/param that fails validation. */
function badRequest(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'validation.failed', message, traceId }, 400);
}

/** 403 envelope carrying the guard reason for observability. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 404 envelope for an attachment invisible to this tenant. */
function notFound(traceId: string): HttpException {
  return new HttpException(
    { code: 'not_found', message: 'attachment not found', traceId },
    404,
  );
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

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

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Rejects a path param that is not a UUID before any query runs. */
function requireUuidParam(value: string, label: string, traceId: string): string {
  if (!UUID_RE.test(value)) throw badRequest(`Invalid ${label}`, traceId);
  return value;
}

function isFileModule(value: unknown): value is FileModule {
  return typeof value === 'string' && (FILE_MODULES as readonly string[]).includes(value);
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

async function loadFacts(actor: ActorContext, module: FileModule): Promise<ActorFacts> {
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
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly attemptedAction: string;
}

/**
 * Runs the central rule and audits any denial before throwing 403.
 * `attachments` carries no org node, so callers pass the membership node (the
 * list-read pattern): the scope term is trivially satisfied for members and
 * denies by default for membership-less callers.
 */
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
    stateAllows: true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'attachment',
      entityId: options.entityId ?? null,
      orgNodeId: auditOrgNodeId,
      attemptedAction: options.attemptedAction,
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
  readonly orgNodeId: string | null;
  readonly diff: Record<string, unknown>;
}

/** Appends one row per successful operation (§4.4); trace id rides in `diff`. */
async function writeAudit(
  actor: ActorContext,
  membership: MembershipRecord,
  entry: AuditEntry,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    entry.action,
    'attachment',
    entry.entityId,
    entry.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...entry.diff }),
    actor.ip,
  ]);
}

// ============ injectable runtime (clocks, ids, bucket) ============

/** Overrides the service reads instead of the environment (tests, jobs). */
export interface FilesOverrides {
  /** Bucket binding; defaults to `resolveS3Config(process.env)`. */
  readonly s3?: S3Config;
  /** Signing instant; defaults to the real clock. */
  readonly now?: Date;
  /** Object-id factory; defaults to `randomUUID` (UUID v4). */
  readonly newId?: () => string;
}

function resolveRuntime(overrides: FilesOverrides = {}): {
  readonly s3: S3Config;
  readonly now: Date;
  readonly newId: () => string;
} {
  return {
    s3: overrides.s3 ?? resolveS3Config(process.env as Record<string, string | undefined>),
    now: overrides.now ?? new Date(),
    newId: overrides.newId ?? randomUUID,
  };
}

// ============ row shapes ============

/** Signed upload grant returned to the client. */
export interface FileUploadGrant {
  readonly attachmentId: string;
  readonly bucketKey: string;
  readonly uploadUrl: string;
  readonly expiresIn: number;
  readonly mime: string;
  readonly sizeBytes: number;
}

/** Signed download grant returned to the client. */
export interface FileDownloadGrant {
  readonly attachmentId: string;
  readonly bucketKey: string;
  readonly downloadUrl: string;
  readonly expiresIn: number;
  readonly mime: string;
  readonly sizeBytes: number;
}

const INSERT_ATTACHMENT_SQL = `INSERT INTO attachments
  (tenant_id, bucket_key, sha256, mime, size_bytes, uploaded_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id`;

const SELECT_ATTACHMENT_SQL = `SELECT id, tenant_id, bucket_key, sha256, mime, size_bytes
FROM attachments WHERE tenant_id = $1 AND id = $2`;

interface UploadInput {
  readonly module: FileModule;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

/** Validates the `POST /v1/files/request-upload` body (412-free 400s). */
function parseUploadBody(body: unknown, traceId: string): UploadInput {
  const record = asRecord(body);
  const module = record.module;
  if (!isFileModule(module)) {
    throw badRequest(`Invalid module (expected one of ${FILE_MODULES.join(', ')})`, traceId);
  }
  const mime = readString(record.mime)?.trim() ?? '';
  if (mime === '' || mime.length > 127) {
    throw badRequest('mime is required (max 127 characters)', traceId);
  }
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mime)) {
    throw badRequest(`Unsupported mime (expected one of ${ALLOWED_MIME_TYPES.join(', ')})`, traceId);
  }
  const sizeBytes = readNumber(record.sizeBytes);
  if (sizeBytes === undefined || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw badRequest('sizeBytes must be a positive integer', traceId);
  }
  if (sizeBytes > FILE_SIZE_LIMIT_BYTES) {
    throw badRequest(`sizeBytes exceeds the ${FILE_SIZE_LIMIT_BYTES}-byte limit`, traceId);
  }
  const rawSha = record.sha256;
  if (rawSha !== undefined && rawSha !== null) {
    if (typeof rawSha !== 'string' || !SHA256_RE.test(rawSha.trim())) {
      throw badRequest('sha256 must be a 64-character hex digest', traceId);
    }
    return { module, mime, sizeBytes, sha256: rawSha.trim().toLowerCase() };
  }
  return { module, mime, sizeBytes, sha256: null };
}

/**
 * Mints a signed upload grant: validates the request, authorizes the module
 * write, registers the `attachments` row under the canonical key and signs
 * the PUT (≤5 min). The row is written *before* signing so no URL exists for
 * an untracked object; the hash travels as a pending marker when the client
 * does not know it yet (it can always be reconciled after the PUT).
 */
export async function requestFileUpload(
  actor: ActorContext,
  body: unknown,
  overrides: FilesOverrides = {},
): Promise<FileUploadGrant> {
  const input = parseUploadBody(body, actor.traceId);
  const { s3, now, newId } = resolveRuntime(overrides);

  const facts = await loadFacts(actor, input.module);
  const membership = await authorize(actor, facts, {
    action: MODULE_ACTIONS[input.module].write,
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'file.request_upload',
  });

  const objectId = newId();
  const dateISO = now.toISOString().slice(0, 10);
  const bucketKey = buildObjectKey(actor.tenantId, input.module, dateISO, objectId);

  const result = await actor.client.query(INSERT_ATTACHMENT_SQL, [
    actor.tenantId,
    bucketKey,
    input.sha256 ?? `pending:${objectId}`,
    input.mime,
    input.sizeBytes,
    actor.userId,
  ]);
  const attachmentId = readString(readRows(result)[0]?.id);
  if (attachmentId === undefined) {
    throw new HttpException(
      { code: 'write.failed', message: 'Attachment insert returned no row', traceId: actor.traceId },
      500,
    );
  }

  const uploadUrl = presignPutUrl(s3, bucketKey, SIGNED_URL_TTL_SECONDS, now);
  await writeAudit(actor, membership, {
    action: 'file.upload_requested',
    entityId: attachmentId,
    orgNodeId: facts.membership?.orgNodeId ?? null,
    diff: {
      module: input.module,
      bucketKey,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      expiresIn: SIGNED_URL_TTL_SECONDS,
    },
  });
  return {
    attachmentId,
    bucketKey,
    uploadUrl,
    expiresIn: SIGNED_URL_TTL_SECONDS,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
  };
}

/**
 * Mints a signed download grant: loads the tenant-scoped `attachments` row,
 * re-parses the stored key (non-canonical keys and cross-tenant keys fail
 * closed), authorizes the module read and signs the GET (≤5 min). No permanent
 * URL is ever handed out, including for non-health modules.
 */
export async function getFileDownload(
  actor: ActorContext,
  attachmentId: string,
  overrides: FilesOverrides = {},
): Promise<FileDownloadGrant> {
  const id = requireUuidParam(attachmentId, 'attachment id', actor.traceId);
  const { s3, now } = resolveRuntime(overrides);

  const result = await actor.client.query(SELECT_ATTACHMENT_SQL, [actor.tenantId, id]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound(actor.traceId);
  const bucketKey = readString(row.bucket_key);
  if (bucketKey === undefined) throw notFound(actor.traceId);

  // Key-side authorization: only canonical keys name their tenant and module.
  const parsed = parseObjectKey(bucketKey);
  if (parsed === null) {
    throw new HttpException(
      { code: FILE_REASON.unsupportedKey, message: 'Attachment key is not a canonical file key', traceId: actor.traceId },
      404,
    );
  }
  if (parsed.tenantId !== actor.tenantId.toLowerCase()) {
    throw new HttpException(
      { code: FILE_REASON.tenantMismatch, message: 'Attachment belongs to another tenant', traceId: actor.traceId },
      404,
    );
  }

  const facts = await loadFacts(actor, parsed.module);
  const membership = await authorize(actor, facts, {
    action: MODULE_ACTIONS[parsed.module].read,
    entityId: id,
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'file.download',
  });

  const mime = readString(row.mime) ?? 'application/octet-stream';
  const sizeBytes = readNumber(row.size_bytes) ?? 0;
  const downloadUrl = presignGetUrl(s3, bucketKey, SIGNED_URL_TTL_SECONDS, now);
  await writeAudit(actor, membership, {
    action: 'file.download_requested',
    entityId: id,
    orgNodeId: facts.membership?.orgNodeId ?? null,
    diff: { module: parsed.module, bucketKey, expiresIn: SIGNED_URL_TTL_SECONDS },
  });
  return {
    attachmentId: id,
    bucketKey,
    downloadUrl,
    expiresIn: SIGNED_URL_TTL_SECONDS,
    mime,
    sizeBytes,
  };
}
