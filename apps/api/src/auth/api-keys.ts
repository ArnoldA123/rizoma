// Tenant API keys — machine auth over `X-Api-Key` (W1).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the whole management use case:
//   1. build the actor from the request the tenant middleware already bound;
//   2. load the membership + org subtree and run the central rule through
//      `canActivate` — which audits every denial as `access.denied`;
//   3. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every write, append one `audit_log` row.
//
// Security contract:
// - The opaque secret is generated with 256-bit entropy, shown EXACTLY once
//   (the create response) and stored only as a SHA-256 hex digest (`key_hash`).
//   Comparison is digest-against-digest; the clear secret never touches disk.
// - `key_prefix` is a display-only identifier (first digest bytes), so the
//   list shows operators WHICH key a row is without exposing anything usable.
// - Management (create/list/revoke) requires a tenant admin membership:
//   `ti_admin` (tenant operator) or `direccion` (tenant management). Any other
//   role — including service callers authenticated by API key — is denied with
//   `role.denied` and the denial is audited. Narrow to `ti_admin` only if the
//   deployment wants a single key custodian.
// - Revocation is `active = false` (or an expired window). The middleware
//   resolves the key through `verify_api_key` on EVERY request — no permission
//   cache, same contract as memberships (`PERMISSION_CACHE_TTL_MS = 0`) — so a
//   revocation is effective on the next request.
import { HttpException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from './access.guard.ts';

/** Request header carrying the opaque secret (also mirrored in contracts). */
export const API_KEY_HEADER = 'x-api-key';

/** Machine-readable rejection for a presented key that does not verify. */
export const API_KEY_INVALID_CODE = 'auth.api_key_invalid';

/** Roles allowed to manage tenant keys (documented above). */
export const TENANT_ADMIN_ROLES = ['ti_admin', 'direccion'] as const;

/** Rows the list endpoint returns at most; keeps a stray wide scan bounded. */
export const API_KEY_LIST_LIMIT = 200;

/** Entropy of one secret (256-bit, base64url-encoded on the wire). */
const SECRET_RANDOM_BYTES = 32;

/** Public wire prefix of an issued secret (identification only). */
const SECRET_PREFIX = 'rizoma_';

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface ApiKeyClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Framework-free request shape the controller forwards (structural). */
export interface ApiKeyRequest {
  headers?: Record<string, string | string[] | undefined>;
  tenant?: { tenantId: string; userId: string; scopes: readonly string[] };
  tenantClient?: ApiKeyClient;
}

/** Everything a use case needs from the request, framework-free. */
export interface ApiKeyActor {
  readonly client: ApiKeyClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly traceId: string;
  readonly ip: string | null;
}

/** One key as the list/revoke endpoints return it — never the secret. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly active: boolean;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly createdAt: string | null;
}

/** Create answer: the record plus the secret, shown exactly once. */
export interface ApiKeyCreated extends ApiKeyRecord {
  readonly secret: string;
}

/** Verified key as the tenant middleware consumes it (no secret, no hash). */
export interface VerifiedApiKey {
  readonly keyId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
}

/** Validated `POST /v1/api-keys` body. */
export interface ApiKeyCreateInput {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly validTo: string | null;
}

// ============ secret handling ============

/** SHA-256 hex digest of an opaque secret; the only form ever stored. */
export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Issues one opaque secret (`rizoma_` + 256-bit base64url) with its digest and
 * its display-only prefix (leading digest bytes: non-reversible, stable).
 */
export function generateApiKeySecret(): { secret: string; keyHash: string; keyPrefix: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(SECRET_RANDOM_BYTES).toString('base64url')}`;
  const keyHash = hashApiKeySecret(secret);
  return { secret, keyHash, keyPrefix: keyHash.slice(0, 8) };
}

/** True for the two tenant admin roles that may manage keys. */
export function isTenantAdminRole(role: string): boolean {
  return (TENANT_ADMIN_ROLES as readonly string[]).includes(role);
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

/** 404 envelope for a key that does not exist in the tenant. */
function notFound(traceId: string): HttpException {
  return new HttpException({ code: 'not_found', message: 'API key not found', traceId }, 404);
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
 * bound (`tenant` + `tenantClient`). API-key callers land here exactly like
 * JWT callers: for them `userId` is the verified key id (a UUID), so the
 * membership lookup below finds no row and only tenant admins holding a human
 * membership can manage keys.
 */
export function actorFromApiRequest(req: ApiKeyRequest): ApiKeyActor {
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const item of value) {
    const text = readString(item);
    if (text !== undefined) entries.push(text);
  }
  return entries;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

/** `pg` hands timestamptz back as `Date`; normalize to ISO, keep nulls. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Maps a raw `api_keys` row onto the list shape (no secret, no hash). */
export function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    name: readString(row.name) ?? '',
    keyPrefix: readString(row.key_prefix) ?? '',
    scopes: readStringArray(row.scopes),
    active: readBoolean(row.active),
    validFrom: toIso(row.valid_from),
    validTo: toIso(row.valid_to),
    createdAt: toIso(row.created_at),
  };
}

// ============ SQL ============

const SELECT_SUBTREE_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM org_nodes WHERE tenant_id = $1 AND id = $2
  UNION ALL
  SELECT n.id FROM org_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.tenant_id = $1
)
SELECT id FROM subtree`;

const INSERT_API_KEY_SQL = `INSERT INTO api_keys
  (tenant_id, name, key_hash, key_prefix, scopes, active, valid_from, valid_to)
VALUES ($1, $2, $3, $4, $5, TRUE, now(), $6)
RETURNING id, tenant_id, name, key_prefix, scopes, active, valid_from, valid_to, created_at`;

const SELECT_API_KEYS_SQL = `SELECT id, tenant_id, name, key_prefix, scopes, active, valid_from, valid_to, created_at
FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT ${API_KEY_LIST_LIMIT}`;

const REVOKE_API_KEY_SQL = `UPDATE api_keys SET active = false WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, name, key_prefix, scopes, active, valid_from, valid_to, created_at`;

/**
 * Pre-tenant lookup for the middleware. `verify_api_key` is SECURITY DEFINER:
 * it runs before `app.tenant_id` is set, when FORCE RLS would hide every row
 * from the app role. Unknown, revoked and out-of-window keys yield zero rows.
 */
const VERIFY_API_KEY_SQL = 'SELECT key_id, tenant_id, scopes FROM verify_api_key($1)';

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

// ============ guard facts ============

/** Loads the membership and, when present, the subtree under its node. */
async function loadFacts(
  actor: ApiKeyActor,
): Promise<{ membership: MembershipRecord | null; scopeSubtree: string[] }> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  if (membership === null) return { membership, scopeSubtree: [] };
  const result = await actor.client.query(SELECT_SUBTREE_SQL, [actor.tenantId, membership.orgNodeId]);
  const scopeSubtree: string[] = [];
  for (const row of readRows(result)) {
    if (typeof row.id === 'string') scopeSubtree.push(row.id);
  }
  return { membership, scopeSubtree };
}

/**
 * The management gate: only an active, in-window tenant admin membership
 * passes. Runs the central rule so every denial is audited as `access.denied`
 * with the caller-visible reason (`membership.inactive`, `role.denied`, ...).
 * There is no tenant-module gate for key management (`moduleActive: true`):
 * keys authenticate the tenant itself, not one vertical.
 */
async function authorizeAdmin(
  actor: ApiKeyActor,
  membership: MembershipRecord | null,
  scopeSubtree: readonly string[],
  attemptedAction: string,
): Promise<MembershipRecord> {
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: [], scope: [] },
    membership,
    entityOrgNodeId: membership?.orgNodeId ?? actor.tenantId,
    scopeSubtree: [...scopeSubtree],
    rolePermits: membership !== null && isTenantAdminRole(membership.role),
    stateAllows: true,
    moduleActive: true,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'api_key',
      entityId: null,
      orgNodeId: membership?.orgNodeId ?? null,
      attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return membership as MembershipRecord;
}

/** Appends one row per successful key write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: ApiKeyActor,
  membership: MembershipRecord,
  action: string,
  keyId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    action,
    'api_key',
    keyId,
    membership.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...diff }),
    actor.ip,
  ]);
}

// ============ input validation ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Validates the create body; mirrors `apiKeyCreateInputSchema` (contracts). */
export function parseApiKeyCreateInput(body: unknown, traceId: string): ApiKeyCreateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with name, scopes and validTo', traceId);
  }
  const record = body as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '' || name.length > 120) {
    throw badRequest('name is required (1-120 characters)', traceId);
  }
  const rawScopes = record.scopes ?? [];
  if (!Array.isArray(rawScopes)) {
    throw badRequest('scopes must be an array of scope strings', traceId);
  }
  const scopes: string[] = [];
  for (const entry of rawScopes) {
    if (typeof entry !== 'string' || !SCOPE_RE.test(entry.trim())) {
      throw badRequest(`scope is invalid: ${String(entry)}`, traceId);
    }
    scopes.push(entry.trim());
  }
  const rawValidTo = record.validTo ?? null;
  if (rawValidTo !== null) {
    if (typeof rawValidTo !== 'string' || Number.isNaN(Date.parse(rawValidTo))) {
      throw badRequest('validTo must be an ISO-8601 timestamp or null', traceId);
    }
    if (Date.parse(rawValidTo) <= Date.now()) {
      throw badRequest('validTo must be in the future', traceId);
    }
  }
  return { name, scopes, validTo: rawValidTo };
}

// ============ use cases ============

/**
 * `POST /v1/api-keys` — issues one key. Returns the record plus the secret;
 * the secret is shown here exactly once and never again.
 */
export async function createApiKey(actor: ApiKeyActor, body: unknown): Promise<ApiKeyCreated> {
  const input = parseApiKeyCreateInput(body, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'api_key.issue');

  const { secret, keyHash, keyPrefix } = generateApiKeySecret();
  const result = await actor.client.query(INSERT_API_KEY_SQL, [
    actor.tenantId,
    input.name,
    keyHash,
    keyPrefix,
    input.scopes,
    input.validTo,
  ]);
  const rows = readRows(result);
  if (rows.length === 0) {
    throw new HttpException(
      { code: 'api_key.issue_failed', message: 'Could not issue the API key', traceId: actor.traceId },
      500,
    );
  }
  const record = mapApiKeyRow(rows[0]);
  await writeAudit(actor, admin, 'api_key.issued', record.id, {
    keyPrefix: record.keyPrefix,
    name: record.name,
    scopes: [...record.scopes],
  });
  return { ...record, secret };
}

/** `GET /v1/api-keys` — lists the tenant keys, newest first, without secrets. */
export async function listApiKeys(actor: ApiKeyActor): Promise<ApiKeyRecord[]> {
  const { membership, scopeSubtree } = await loadFacts(actor);
  await authorizeAdmin(actor, membership, scopeSubtree, 'api_key.list');
  const result = await actor.client.query(SELECT_API_KEYS_SQL, [actor.tenantId]);
  return readRows(result).map(mapApiKeyRow);
}

/**
 * `POST /v1/api-keys/:id/revoke` — deactivates one key. Idempotent: revoking
 * an already revoked key answers the row again. Unknown ids answer 404.
 * Effective on the next request: verification reads the table every time.
 */
export async function revokeApiKey(actor: ApiKeyActor, id: string): Promise<ApiKeyRecord> {
  if (!UUID_RE.test(id)) throw badRequest('id must be a UUID', actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'api_key.revoke');
  const result = await actor.client.query(REVOKE_API_KEY_SQL, [id, actor.tenantId]);
  const rows = readRows(result);
  if (rows.length === 0) throw notFound(actor.traceId);
  const record = mapApiKeyRow(rows[0]);
  await writeAudit(actor, admin, 'api_key.revoked', record.id, { keyPrefix: record.keyPrefix });
  return record;
}

/**
 * Request-time verification for `TenantContextMiddleware`: hashes the
 * presented secret and resolves it through `verify_api_key`. Returns null for
 * an unknown, revoked or out-of-window key — the middleware then answers 401
 * without falling through to any other identity source (fail closed).
 */
export async function verifyApiKey(
  client: ApiKeyClient,
  secret: string,
): Promise<VerifiedApiKey | null> {
  if (secret.trim() === '') return null;
  const result = await client.query(VERIFY_API_KEY_SQL, [hashApiKeySecret(secret)]);
  const row = readRows(result)[0];
  if (row === undefined) return null;
  const keyId = readString(row.key_id);
  const tenantId = readString(row.tenant_id);
  if (keyId === undefined || tenantId === undefined) return null;
  return { keyId, tenantId, scopes: readStringArray(row.scopes) };
}
