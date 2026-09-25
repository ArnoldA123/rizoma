// Keycloak access-token verification (bases-consolidadas-v1.md §3.1, §3.3).
//
// This module is the identity source of the API: the tenant middleware and the
// access guard trust nothing that a client sends directly, they trust only the
// identity extracted from a signed token. Verification is RS256-only against
// the realm JWKS, using `node:crypto` and the global `fetch` — no new
// dependency is added for cryptography or HTTP.
//
// Tenant claim contract (documented on purpose, because it is deployment data):
// - The preferred claim is `tenant_id` (constant {@link CLAIM_TENANT}). It must
//   be emitted by a Keycloak protocol mapper (hardcoded claim or user-attribute
//   mapper) on the realm `rizoma`.
// - When `tenant_id` is absent the verifier falls back to `azp` (the authorized
//   party, i.e. the OIDC client id). That fallback supports deployments that
//   provision one Keycloak client per tenant; the resulting value still has to
//   be a UUID v4, otherwise the tenant middleware rejects the request with
//   `tenant.missing`.
// - A deployment can override the primary claim per call through
//   {@link VerifyOptions.tenantClaim}; the default stays `tenant_id`.
//
// JWKS caching: the realm key set changes rarely, so it is cached in memory
// for {@link JWKS_CACHE_TTL_MS} (10 minutes). A token signed with an unknown
// `kid` forces exactly one cache-bypassing refresh before being rejected, which
// is what makes key rotation take effect without a process restart.
//
// Errors are typed ({@link AuthError}) and carry the machine-readable `code`
// of the `{code, message, traceId}` envelope; the caller adds the `traceId`
// because it owns the request context.
//
// Manual end-to-end check against the local realm (the demo users carry the
// `CONFIGURE_TOTP` required action, so a direct password grant answers
// "Account is not fully set up"; the service-account client works instead):
//
//   TOKEN=$(curl -s -X POST \
//     'http://localhost:8080/realms/rizoma/protocol/openid-connect/token' \
//     -H 'Content-Type: application/x-www-form-urlencoded' \
//     -d 'grant_type=client_credentials' \
//     -d 'client_id=rizoma-api' \
//     -d 'client_secret=rizoma_api_demo_secret' | node -pe \
//     'JSON.parse(require("fs").readFileSync(0,"utf8")).access_token')
//   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
//     http://127.0.0.1:3001/v1/any-protected-path
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { ApiConfig } from '../config/configuration.ts';

/** Machine-readable verification failures. */
export const AUTH_ERROR_CODES = {
  tokenInvalid: 'auth.token_invalid',
  tokenExpired: 'auth.token_expired',
  jwksUnavailable: 'auth.jwks_unavailable',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/** Verification failure; `code` feeds the `{code, message, traceId}` envelope. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Verified caller identity. `tenantId` is the resolved tenant claim value. */
export interface Identity {
  readonly sub: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly scope: readonly string[];
}

/** Verifies one bearer token and resolves its identity. */
export type JwtVerifier = (token: string) => Promise<Identity>;

/** Primary claim carrying the tenant id. */
export const CLAIM_TENANT = 'tenant_id';
/** Fallback claim: OIDC authorized party (client id, one client per tenant). */
export const CLAIM_TENANT_FALLBACK = 'azp';
/** Realm roles claim nesting used by Keycloak. */
export const CLAIM_REALM_ACCESS = 'realm_access';

/** Realm key set TTL in the in-memory cache (10 minutes). */
export const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

/** Only this algorithm is accepted; `none`, `HS*` and friends are rejected. */
const REQUIRED_ALG = 'RS256';

/** JWKS/issuer URLs for a realm, derived from the Keycloak base URL. */
export function keycloakJwksUrl(baseUrl: string, realm: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/realms/${realm}/protocol/openid-connect/certs`;
}

export function keycloakIssuer(baseUrl: string, realm: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/realms/${realm}`;
}

/** Injection token for the request-time Keycloak verifier. */
export const AUTH_JWT_VERIFIER = 'AUTH_JWT_VERIFIER';

/**
 * Builds the verifier bound to one realm. `AppModule` injects it, so no request
 * path ever reads the environment or rebuilds the JWKS URL.
 */
export function createKeycloakVerifier(
  config: Pick<ApiConfig, 'keycloakUrl' | 'keycloakRealm'>,
): JwtVerifier {
  const jwksUrl = keycloakJwksUrl(config.keycloakUrl, config.keycloakRealm);
  const issuer = keycloakIssuer(config.keycloakUrl, config.keycloakRealm);
  return (token: string) => verifyKeycloakJwt(token, jwksUrl, issuer);
}

/** Public JSON Web Key as published by the realm (RSA subset we consume). */
export interface Jwk {
  readonly kty?: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

interface JwksCacheEntry {
  readonly fetchedAt: number;
  readonly keys: Map<string, Jwk>;
}

/** One entry per JWKS URL; the set is small and the process is single-realm. */
const jwksCache = new Map<string, JwksCacheEntry>();

/** Test/ops hook: drops every cached key set. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

/** Test/ops hook: number of cached key sets (0 or 1 in normal operation). */
export function jwksCacheSize(): number {
  return jwksCache.size;
}

export interface VerifyOptions {
  /** Claim carrying the tenant id; defaults to {@link CLAIM_TENANT}. */
  readonly tenantClaim?: string;
  /** Injectable clock (milliseconds). Defaults to `Date.now()`. */
  readonly nowMs?: number;
  /** Injectable fetch, so the verifier is testable without a live realm. */
  readonly fetchImpl?: typeof fetch;
  /** Extra seconds tolerated on `exp`/`nbf`; defaults to 0. */
  readonly clockSkewSeconds?: number;
  /** Request timeout for one JWKS fetch; defaults to 3000 ms. */
  readonly jwksTimeoutMs?: number;
}

/** Default fetch timeout; a hung realm must not hold a request open. */
const DEFAULT_JWKS_TIMEOUT_MS = 3_000;

interface DecodedToken {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Buffer;
}

function invalid(message: string): AuthError {
  return new AuthError(AUTH_ERROR_CODES.tokenInvalid, message);
}

function jwksUnavailable(message: string): AuthError {
  return new AuthError(AUTH_ERROR_CODES.jwksUnavailable, message);
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw invalid(`Malformed token: ${what} is not base64url-encoded JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid(`Malformed token: ${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Splits and decodes a compact JWS without trusting any of its content. */
function decodeToken(token: string): DecodedToken {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw invalid('Malformed token: expected a compact JWS with three segments');
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  return {
    header: decodeSegment(headerSegment, 'header'),
    payload: decodeSegment(payloadSegment, 'payload'),
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature: Buffer.from(signatureSegment, 'base64url'),
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

/** Realm roles: `realm_access.roles`, with a flat `roles` claim as fallback. */
function readRoles(payload: Record<string, unknown>): string[] {
  const realmAccess = payload[CLAIM_REALM_ACCESS];
  if (realmAccess !== null && typeof realmAccess === 'object' && !Array.isArray(realmAccess)) {
    const roles = readStringArray((realmAccess as Record<string, unknown>).roles);
    if (roles.length > 0) return [...new Set(roles)];
  }
  return [...new Set(readStringArray(payload.roles))];
}

/** OAuth scopes: space-delimited `scope`, with the `scp` array as fallback. */
function readScope(payload: Record<string, unknown>): string[] {
  const scope = readString(payload.scope);
  if (scope !== undefined) {
    return [...new Set(scope.split(/\s+/).filter((entry) => entry !== ''))];
  }
  return [...new Set(readStringArray(payload.scp))];
}

/** Primary tenant claim, then `azp`; a token without either is untrusted. */
function readTenantClaim(
  payload: Record<string, unknown>,
  tenantClaim: string,
): string {
  const primary = readString(payload[tenantClaim]);
  if (primary !== undefined) return primary;
  const fallback = readString(payload[CLAIM_TENANT_FALLBACK]);
  if (fallback !== undefined) return fallback;
  throw invalid(`Token carries neither the ${tenantClaim} nor the ${CLAIM_TENANT_FALLBACK} claim`);
}

/** Fetches the realm key set, honouring the in-memory TTL unless forced. */
async function loadJwks(
  jwksUrl: string,
  fetchImpl: typeof fetch,
  now: number,
  timeoutMs: number,
  force: boolean,
): Promise<JwksCacheEntry> {
  const cached = jwksCache.get(jwksUrl);
  if (!force && cached !== undefined && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached;
  }

  let response: Response;
  try {
    response = await fetchImpl(jwksUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw jwksUnavailable(`JWKS endpoint unreachable: ${detail}`);
  }
  if (!response.ok) {
    throw jwksUnavailable(`JWKS endpoint answered HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw jwksUnavailable('JWKS endpoint did not return valid JSON');
  }

  const rawKeys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(rawKeys)) {
    throw jwksUnavailable('JWKS document has no `keys` array');
  }

  const keys = new Map<string, Jwk>();
  for (const raw of rawKeys) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const jwk = raw as Jwk;
    const kid = readString(jwk.kid);
    if (kid === undefined) continue;
    keys.set(kid, jwk);
  }

  const entry: JwksCacheEntry = { fetchedAt: now, keys };
  jwksCache.set(jwksUrl, entry);
  return entry;
}

/**
 * Resolves the signing key for `kid`, refreshing once past the cache when the
 * key is not present (key rotation without a process restart).
 */
async function resolveSigningKey(
  jwksUrl: string,
  kid: string,
  fetchImpl: typeof fetch,
  now: number,
  timeoutMs: number,
): Promise<Jwk> {
  const cached = await loadJwks(jwksUrl, fetchImpl, now, timeoutMs, false);
  const hit = cached.keys.get(kid);
  if (hit !== undefined) return hit;

  const refreshed = await loadJwks(jwksUrl, fetchImpl, now, timeoutMs, true);
  const rotated = refreshed.keys.get(kid);
  if (rotated === undefined) {
    throw invalid(`Token signed with an unknown key id: ${kid}`);
  }
  return rotated;
}

/**
 * Verifies a Keycloak access token and returns its identity.
 *
 * Order matters: the signature is validated before any claim is trusted, then
 * `exp`/`nbf` are checked, then the issuer, and only then the identity claims
 * are read. Any failure is a typed {@link AuthError}.
 */
export async function verifyKeycloakJwt(
  token: string,
  jwksUrl: string,
  expectedIss: string,
  options: VerifyOptions = {},
): Promise<Identity> {
  const now = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS;
  const skewMs = (options.clockSkewSeconds ?? 0) * 1000;
  const tenantClaim = options.tenantClaim ?? CLAIM_TENANT;

  const { header, payload, signingInput, signature } = decodeToken(token);

  const alg = readString(header.alg);
  if (alg !== REQUIRED_ALG) {
    throw invalid(`Unsupported token algorithm: ${alg ?? 'missing'} (expected ${REQUIRED_ALG})`);
  }
  const kid = readString(header.kid);
  if (kid === undefined) {
    throw invalid('Token header has no key id (kid)');
  }

  const jwk = await resolveSigningKey(jwksUrl, kid, fetchImpl, now, timeoutMs);

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw invalid(`JWKS key ${kid} is not a usable RSA public key: ${detail}`);
  }

  const signatureValid = verifySignature(
    'RSA-SHA256',
    Buffer.from(signingInput, 'utf8'),
    publicKey,
    signature,
  );
  if (!signatureValid) {
    throw invalid('Token signature does not match the realm key');
  }

  const issuer = readString(payload.iss);
  if (issuer === undefined || issuer !== expectedIss) {
    throw invalid(`Unexpected token issuer: ${issuer ?? 'missing'}`);
  }

  const expiresAt = readNumber(payload.exp);
  if (expiresAt === undefined) {
    throw invalid('Token has no numeric exp claim');
  }
  if (now >= expiresAt * 1000 + skewMs) {
    throw new AuthError(AUTH_ERROR_CODES.tokenExpired, 'Token has expired');
  }

  const notBefore = readNumber(payload.nbf);
  if (notBefore !== undefined && now + skewMs < notBefore * 1000) {
    throw invalid('Token is not valid yet (nbf is in the future)');
  }

  const sub = readString(payload.sub);
  if (sub === undefined) {
    throw invalid('Token has no subject (sub) claim');
  }

  return {
    sub,
    tenantId: readTenantClaim(payload, tenantClaim),
    roles: readRoles(payload),
    scope: readScope(payload),
  };
}
