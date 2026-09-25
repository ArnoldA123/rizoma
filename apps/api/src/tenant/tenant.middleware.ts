// Per-request tenant context (bases-consolidadas-v1.md §4.2, §5.1).
//
// Contract: every business request runs inside its own transaction opened
// through PgBouncer (transaction pooling), and the RLS session variables
// `app.tenant_id` / `app.user_id` / `app.scopes` are set with `SET LOCAL`
// semantics before any handler touches tenant data. The pooled client is
// attached to the request so handlers reuse the exact same transaction, and it
// is committed (or rolled back) and released when the response finishes.
//
// Design notes:
// - `SET LOCAL` is expressed as `SELECT set_config(name, value, true)`: the
//   `true` flag gives the LOCAL (transaction-scoped) behaviour and, unlike the
//   `SET` statement, accepts bind parameters, so no header value is ever
//   interpolated into SQL text.
// - `app.scopes` is stored as a space-delimited list (OAuth scope style), the
//   shape endpoint code reads back with `current_setting('app.scopes')`.
// - Identity comes from the verified Keycloak JWT when the request carries an
//   `Authorization: Bearer <token>` header, or from a tenant API key when it
//   carries `X-Api-Key: <opaque secret>` (W1, resolved per request through the
//   `verify_api_key` SECURITY DEFINER function — no permission cache, so a
//   revocation is effective on the next request, like memberships). The
//   raw-header path below is kept only for local tests and non-browser tooling
//   and is documented as such. All paths converge on the same
//   {@link TenantResolution} shape, so the RLS wiring is identity-source
//   agnostic. For API-key requests `userId` is the verified key id (a UUID),
//   which is what `app.user_id` and the audit `actor` carry.
// - A presented API key that does not verify is rejected with 401
//   `auth.api_key_invalid` and never falls through to another identity source
//   (fail closed, same as a presented bearer token).
// - A request without a valid tenant never reaches the pool: it is rejected
//   with 403 `{code:'tenant.missing'}` (mvp1-api-runtime exit criterion 2).
//   A request that *does* carry a bearer token but fails verification is
//   rejected with 401 and a typed `auth.*` code; the header path is never used
//   as a fallback for a presented token (fail closed).
// - This file stays free of TypeScript decorators: `npm test` loads the
//   sources with Node's strip-only type stripping, which rejects decorator
//   syntax, and the tenant contract must stay directly testable. The pool is
//   therefore passed to the constructor explicitly and `AppModule` wires it.
import type { NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  API_KEY_HEADER,
  API_KEY_INVALID_CODE,
  verifyApiKey,
} from '../auth/api-keys.ts';
import {
  buildUsageEndpoint,
  recordApiKeyUsage,
  shouldCountUsage,
} from '../webhooks/usage-counters.ts';
import {
  AUTH_ERROR_CODES,
  AuthError,
  verifyKeycloakJwt,
  type Identity,
  type JwtVerifier,
} from '../auth/jwt.ts';
import type { ApiConfig } from '../config/configuration.ts';

/** Injection token for the shared request-time Postgres pool. */
export const PG_POOL = 'PG_POOL';

/** One pool for the whole process; PgBouncer multiplexes the real backends. */
export const TENANT_POOL_MAX_CONNECTIONS = 10;

/** Correlation header, shared with the health probe envelope convention. */
const TRACE_ID_HEADER = 'x-trace-id';

/** Source header for the tenant id (UUID v4). */
const TENANT_ID_HEADER = 'x-tenant-id';
/** Source header for the acting user id (UUID, any version). */
const USER_ID_HEADER = 'x-user-id';
/** Source header for the granted scopes (comma or space separated). */
const SCOPES_HEADER = 'x-scopes';
/** The only trusted identity source for real traffic: a bearer access token. */
const AUTHORIZATION_HEADER = 'authorization';

/** HTTP status used when a presented bearer token is rejected. */
export const AUTH_UNAUTHORIZED_STATUS = 401;

/** Machine-readable rejection codes; both answer HTTP 403. */
export const TENANT_ERROR_CODES = {
  tenantMissing: 'tenant.missing',
  userInvalid: 'tenant.user_invalid',
} as const;

export type TenantErrorCode = (typeof TENANT_ERROR_CODES)[keyof typeof TENANT_ERROR_CODES];

/** Header bag as Express/Nest hands it over (values may repeat). */
export type HeaderRecord = Record<string, string | string[] | undefined>;

/** Resolved identity for one request. */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly scopes: readonly string[];
}

export interface TenantError {
  readonly code: TenantErrorCode;
  readonly message: string;
}

/** Result of the pure resolution step. */
export type TenantResolution =
  | { readonly ok: true; readonly context: TenantContext }
  | { readonly ok: false; readonly status: 403; readonly error: TenantError };

/** Minimal pooled-client surface the middleware drives. */
export interface TenantClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  release(destroy?: boolean): void;
}

/** Minimal pool surface, so the middleware is testable without Postgres. */
export interface TenantPool {
  connect(): Promise<TenantClient>;
}

/** Request augmented with the tenant transaction bound to it. */
export interface TenantScopedRequest {
  headers?: HeaderRecord;
  tenant?: TenantContext;
  tenantClient?: TenantClient;
  /** Verified API-key id for usage counting; null/undefined for JWT traffic. */
  apiKeyId?: string | null;
  readonly method?: string;
  readonly path?: string;
}

/** Response surface the middleware needs to finalize the transaction. */
export interface TenantResponse {
  statusCode: number;
  status(code: number): TenantResponse;
  json(body: unknown): TenantResponse;
  on(event: 'finish' | 'close', handler: () => void): unknown;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_SEPARATOR_RE = /[\s,]+/;

/** Case-insensitive header read; repeated headers keep their first value. */
function readHeader(headers: HeaderRecord, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

/** Splits the scope list, ignoring empty segments and blank headers. */
function readScopes(headers: HeaderRecord): string[] {
  const raw = readHeader(headers, SCOPES_HEADER);
  if (raw === undefined) return [];
  return raw.split(SCOPE_SEPARATOR_RE).filter((scope) => scope !== '');
}

/** Correlation id for the `{code, message, traceId}` error envelope. */
export function resolveTraceId(headers: HeaderRecord): string {
  return readHeader(headers, TRACE_ID_HEADER) ?? randomUUID();
}

const TENANT_MISSING_MESSAGE =
  'Missing or malformed x-tenant-id header (expected a UUID v4)';
const USER_INVALID_MESSAGE = 'Missing or malformed x-user-id header (expected a UUID)';
const TOKEN_TENANT_INVALID_MESSAGE =
  'Verified token carries no valid tenant id (expected the tenant_id or azp claim to be a UUID v4)';
const TOKEN_USER_INVALID_MESSAGE =
  'Verified token subject (sub) is not a UUID';

/**
 * Resolves the tenant context from request headers. Pure: no I/O, no clock, no
 * container, so it can be exercised exhaustively without Postgres.
 *
 * LOCAL/TEST PATH ONLY: these headers are client-controlled and must never be
 * trusted by production traffic. Real requests take the verified-JWT path in
 * {@link TenantContextMiddleware}; this function stays for local tests and for
 * version-pinned tooling that runs inside a trusted network.
 */
export function resolveTenantContext(headers: HeaderRecord = {}): TenantResolution {
  const tenantId = readHeader(headers, TENANT_ID_HEADER);
  if (tenantId === undefined || !UUID_V4_RE.test(tenantId)) {
    return {
      ok: false,
      status: 403,
      error: { code: TENANT_ERROR_CODES.tenantMissing, message: TENANT_MISSING_MESSAGE },
    };
  }
  const userId = readHeader(headers, USER_ID_HEADER);
  if (userId === undefined || !UUID_RE.test(userId)) {
    return {
      ok: false,
      status: 403,
      error: { code: TENANT_ERROR_CODES.userInvalid, message: USER_INVALID_MESSAGE },
    };
  }
  return { ok: true, context: { tenantId, userId, scopes: readScopes(headers) } };
}

/**
 * A3 identity path: derives the internal tenant context from a verified token.
 *
 * Pure and header-free — the only inputs are claims that {@link verifyKeycloakJwt}
 * already validated. The tenant claim must still be a UUID v4 and the subject a
 * UUID, because `app.tenant_id` / `app.user_id` are cast to `uuid` by the RLS
 * policies; a value that cannot satisfy that cast is rejected before the pool.
 */
export function resolveTenantContextFromIdentity(identity: Identity): TenantResolution {
  if (!UUID_V4_RE.test(identity.tenantId)) {
    return {
      ok: false,
      status: 403,
      error: {
        code: TENANT_ERROR_CODES.tenantMissing,
        message: TOKEN_TENANT_INVALID_MESSAGE,
      },
    };
  }
  if (!UUID_RE.test(identity.sub)) {
    return {
      ok: false,
      status: 403,
      error: { code: TENANT_ERROR_CODES.userInvalid, message: TOKEN_USER_INVALID_MESSAGE },
    };
  }
  return {
    ok: true,
    context: { tenantId: identity.tenantId, userId: identity.sub, scopes: [...identity.scope] },
  };
}

/** `set_config(..., true)` == `SET LOCAL`, with bind parameters. */
const SET_TENANT_ID_SQL = "SELECT set_config('app.tenant_id', $1, true)";
const SET_USER_ID_SQL = "SELECT set_config('app.user_id', $1, true)";
const SET_SCOPES_SQL = "SELECT set_config('app.scopes', $1, true)";

/**
 * Builds the single request-time pool. It points at PgBouncer in transaction
 * mode (§4.2); `DATABASE_URL_PGBOUNCER` falls back to `DATABASE_URL` when unset.
 */
export function createTenantPool(config: ApiConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrlPgbouncer,
    max: TENANT_POOL_MAX_CONNECTIONS,
  });
}

/**
 * Ends the request transaction and returns the client to the pool. A failed
 * finalize leaves the connection in an unknown state, so it is destroyed
 * instead of being reused for another tenant.
 */
async function finalizeTransaction(
  client: TenantClient,
  action: 'COMMIT' | 'ROLLBACK',
): Promise<void> {
  try {
    await client.query(action);
    client.release();
  } catch (error) {
    client.release(true);
    console.error(
      JSON.stringify({
        code: 'tenant.transaction_finalize_failed',
        action,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Keycloak binding for the middleware. `verify` is the DI-provided verifier
 * (built by `AppModule` from the runtime config); `jwksUrl`/`expectedIssuer`
 * let a caller build the default verifier instead, which keeps the unit tests
 * free of a container. When neither is present and a request presents a bearer
 * token, verification fails closed with `auth.jwks_unavailable`.
 */
export interface TenantAuthOptions {
  readonly verify?: JwtVerifier;
  readonly jwksUrl?: string;
  readonly expectedIssuer?: string;
}

/**
 * Opens the tenant transaction, sets the RLS context and binds it to `req`.
 *
 * Strip-only TypeScript (how `node --test` loads these sources) rejects both
 * constructor parameter properties and decorator syntax, hence the plain class
 * with an explicit pool field; `AppModule` constructs it with the injected pool
 * and the injected JWT verifier.
 */
export class TenantContextMiddleware implements NestMiddleware {
  private readonly pool: TenantPool;
  private readonly auth: TenantAuthOptions;

  constructor(pool: TenantPool, auth: TenantAuthOptions = {}) {
    this.pool = pool;
    this.auth = auth;
  }

  /** Verifies a bearer token with the injected verifier or the default one. */
  private async verifyToken(token: string): Promise<Identity> {
    if (this.auth.verify !== undefined) return this.auth.verify(token);
    const { jwksUrl, expectedIssuer } = this.auth;
    if (jwksUrl === undefined || expectedIssuer === undefined) {
      throw new AuthError(
        AUTH_ERROR_CODES.jwksUnavailable,
        'Keycloak JWKS URL and issuer are not configured for this process',
      );
    }
    return verifyKeycloakJwt(token, jwksUrl, expectedIssuer);
  }

  async use(
    req: TenantScopedRequest,
    res: TenantResponse,
    next: (error?: unknown) => void,
  ): Promise<void> {
    const headers = req.headers ?? {};

    // W1: machine auth runs before Bearer. A presented key that does not
    // verify is rejected inside `useApiKey` without touching other sources.
    const apiKeySecret = readHeader(headers, API_KEY_HEADER);
    if (apiKeySecret !== undefined) {
      await this.useApiKey(req, res, next, headers, apiKeySecret);
      return;
    }

    const authorization = readHeader(headers, AUTHORIZATION_HEADER);
    let resolution: TenantResolution;

    if (authorization !== undefined && /^bearer\b/i.test(authorization)) {
      const token = authorization.replace(/^bearer\s*/i, '').trim();
      try {
        if (token === '') {
          throw new AuthError(AUTH_ERROR_CODES.tokenInvalid, 'Empty bearer token');
        }
        resolution = resolveTenantContextFromIdentity(await this.verifyToken(token));
      } catch (error) {
        const authError =
          error instanceof AuthError
            ? error
            : new AuthError(
                AUTH_ERROR_CODES.jwksUnavailable,
                error instanceof Error ? error.message : String(error),
              );
        res.status(AUTH_UNAUTHORIZED_STATUS).json({
          code: authError.code,
          message: authError.message,
          traceId: resolveTraceId(headers),
        });
        return;
      }
    } else {
      resolution = resolveTenantContext(headers);
    }

    if (!resolution.ok) {
      res.status(resolution.status).json({ ...resolution.error, traceId: resolveTraceId(headers) });
      return;
    }

    let client: TenantClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      next(error);
      return;
    }

    try {
      await client.query('BEGIN');
      await client.query(SET_TENANT_ID_SQL, [resolution.context.tenantId]);
      await client.query(SET_USER_ID_SQL, [resolution.context.userId]);
      await client.query(SET_SCOPES_SQL, [resolution.context.scopes.join(' ')]);
    } catch (error) {
      await finalizeTransaction(client, 'ROLLBACK');
      next(error);
      return;
    }

    this.bindClient(req, res, next, client, resolution.context);
  }

  /**
   * API-key branch: resolves the opaque secret through `verify_api_key` inside
   * the request transaction, then binds the same RLS context as every other
   * identity source. The key scopes feed `app.scopes`; the key id feeds
   * `app.user_id` (a UUID, so the RLS cast holds). Unknown, revoked and
   * out-of-window keys answer 401 and never fall through (fail closed).
   */
  private async useApiKey(
    req: TenantScopedRequest,
    res: TenantResponse,
    next: (error?: unknown) => void,
    headers: HeaderRecord,
    secret: string,
  ): Promise<void> {
    let client: TenantClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      next(error);
      return;
    }

    try {
      await client.query('BEGIN');
      const verified = await verifyApiKey(client, secret);
      if (verified === null) {
        await finalizeTransaction(client, 'ROLLBACK');
        res.status(AUTH_UNAUTHORIZED_STATUS).json({
          code: API_KEY_INVALID_CODE,
          message: 'Unknown, revoked or expired API key',
          traceId: resolveTraceId(headers),
        });
        return;
      }
      const context = {
        tenantId: verified.tenantId,
        userId: verified.keyId,
        scopes: [...verified.scopes],
      };
      await client.query(SET_TENANT_ID_SQL, [context.tenantId]);
      await client.query(SET_USER_ID_SQL, [context.userId]);
      await client.query(SET_SCOPES_SQL, [context.scopes.join(' ')]);
      req.apiKeyId = verified.keyId;
      this.bindClient(req, res, next, client, context);
    } catch (error) {
      await finalizeTransaction(client, 'ROLLBACK');
      next(error);
    }
  }

  /**
   * Best-effort hourly usage count for API-key traffic, on a short pool
   * client — never the request transaction (already finalizing on finish).
   * Failures resolve silently inside `recordApiKeyUsage`.
   */
  private countUsage(req: TenantScopedRequest, res: TenantResponse): void {
    const tenantId = req.tenant?.tenantId;
    const apiKeyId = req.apiKeyId ?? null;
    if (tenantId === undefined || !shouldCountUsage(apiKeyId, res.statusCode)) return;
    const endpoint = buildUsageEndpoint(req.method ?? '', req.path ?? '');
    void (async () => {
      let client: TenantClient | null = null;
      try {
        client = await this.pool.connect();
        await recordApiKeyUsage(client, { tenantId, apiKeyId, endpoint });
      } catch {
        // best effort: counting never fails the business request
      } finally {
        client?.release();
      }
    })();
  }

  /**
   * Binds the open transaction to the request and arms the commit/rollback
   * finalizers shared by every identity branch.
   */
  private bindClient(
    req: TenantScopedRequest,
    res: TenantResponse,
    next: (error?: unknown) => void,
    client: TenantClient,
    context: TenantContext,
  ): void {
    req.tenant = context;
    req.tenantClient = client;

    let settled = false;
    const finalize = (aborted: boolean): void => {
      if (settled) return;
      settled = true;
      void finalizeTransaction(client, aborted ? 'ROLLBACK' : 'COMMIT');
    };

    // 5xx responses and aborted connections must not commit partial writes;
    // `settled` keeps 'finish' + 'close' from finalizing twice.
    res.on('finish', () => {
      finalize(res.statusCode >= 500);
      this.countUsage(req, res);
    });
    res.on('close', () => finalize(true));

    next();
  }
}
