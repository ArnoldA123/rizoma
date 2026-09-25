// Server-side session reader.
//
// One place resolves "who is acting" for a Server Component, a Route Handler
// or the proxy. The order is fail-closed and mirrors the tenant middleware:
// a valid session token wins; the local identity headers are consulted only
// when there is no token at all and only outside production; with neither, the
// result is the `tenant.missing` envelope the API would return.
//
// Lazy renewal: when the session cookie exists but is expired (past the 30s
// safety margin in `sessionIsExpired`) and a refresh grant is stored,
// resolution calls `ensureFreshAccessToken` once and renders from the renewed
// token set in memory. That is what closes H6c — the middleware already lets
// `expired-access + refresh presente` through for lazy downstream renewal, but
// without this step `currentSession` kept returning `expired: true` and every
// page rendered `SessionRequiredNotice` until some proxy/session round-trip
// happened to renew first. A rejected or missing refresh stays fail-closed:
// the result is the expired identity exactly as before.
//
// Why in-memory only: a Server Component cannot set cookies — `cookies()`
// from `next/headers` is read-only during render, and writing from here
// throws. The renewed set therefore applies to this render; persistence back
// to `SESSION_COOKIE`/`REFRESH_COOKIE` stays with the callers that own a
// writable response (the `proxy` and `session` Route Handlers already call
// `ensureFreshAccessToken` and re-persist on their own responses). The next
// proxy/session round-trip persists what this render renewed.
//
// `next/headers` is imported dynamically inside the readers (never at module
// top level) so the pure resolver below stays importable under plain
// `node --test`: loading this module must not resolve the Next runtime, only
// calling `currentSession`/`currentAccessToken`/`readSessionCookie` does.
// `cookies()` and `headers()` are async in Next 15, so every reader is async
// too — that is also what makes the pages that call them dynamic instead of
// being prerendered with an empty identity.
import { DEV_IDENTITY, SESSION_COOKIE } from './config.ts';
import { ensureFreshAccessToken, type CookieReader } from './refresh.ts';
import { DEV_HEADERS_ENABLED } from './server-config.ts';
import { decodeSession, sessionIsExpired, type SessionTokenSet } from './session-codec.ts';
import { deriveIdentity, type DevIdentityHeaders, type IdentityResolution } from './tenant.ts';

/** Everything a page needs to render the session banner truthfully. */
export interface CurrentSession {
  /** Valid, unexpired token set; `null` when absent or expired. */
  readonly tokens: SessionTokenSet | null;
  /** Whether the cookie existed but was past its expiry. */
  readonly expired: boolean;
  readonly identity: IdentityResolution;
  /** True when the local identity headers supplied the tenant. */
  readonly usingDevFallback: boolean;
}

/** Test/realm options threading through the server-side resolution. */
export interface ResolveSessionOptions {
  readonly nowMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Reads and validates the raw session cookie. */
export async function readSessionCookie(): Promise<SessionTokenSet | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

/**
 * Pure session resolver: the whole fail-closed decision tree over an explicit
 * cookie jar, without touching `next/headers`, so it is unit testable with
 * `node --test`. `currentSession` is the thin wrapper that builds the jar
 * from the real request cookies/headers and delegates here.
 *
 * Order: a fresh session wins; an expired session attempts exactly one lazy
 * renewal via `ensureFreshAccessToken` and, when the realm accepts the grant,
 * resolves identity from the renewed access token; anything else (no session,
 * rejected/unreachable/missing refresh, undecodable renewal) falls through to
 * the development fallback and then to the expired/missing identity — the same
 * envelopes pages rendered before H6c.
 */
export async function resolveSessionFromJar(
  jar: CookieReader,
  devHeaders: DevIdentityHeaders | null,
  options?: ResolveSessionOptions,
): Promise<CurrentSession> {
  const nowMs = options?.nowMs ?? Date.now();
  const renewalOptions =
    options?.fetchImpl === undefined ? { nowMs } : { nowMs, fetchImpl: options.fetchImpl };

  const stored = decodeSession(jar.get(SESSION_COOKIE));
  const expired = stored !== null && sessionIsExpired(stored, nowMs);
  if (stored !== null && !expired) {
    return {
      tokens: stored,
      expired: false,
      identity: deriveIdentity({ token: stored.accessToken }),
      usingDevFallback: false,
    };
  }

  // Expired access token with a stored grant: one lazy realm round-trip.
  // Fail-closed: any `unauthorized` outcome (missing/rejected/unreachable
  // refresh) falls through to the expired identity below, exactly as before.
  // A missing session (`stored === null`) never attempts renewal, mirroring
  // the middleware gate: a stray refresh grant without a session cookie is
  // not enough to mint an identity for a page render.
  if (stored !== null && expired) {
    const ensured = await ensureFreshAccessToken(jar, renewalOptions);
    if (ensured.status === 'refreshed') {
      const renewed = decodeSession(ensured.sessionCookieValue);
      if (renewed !== null) {
        return {
          tokens: renewed,
          expired: false,
          identity: deriveIdentity({ token: ensured.accessToken }),
          usingDevFallback: false,
        };
      }
    } else if (ensured.status === 'fresh') {
      const fresh = decodeSession(jar.get(SESSION_COOKIE));
      if (fresh !== null && !sessionIsExpired(fresh, nowMs)) {
        return {
          tokens: fresh,
          expired: false,
          identity: deriveIdentity({ token: fresh.accessToken }),
          usingDevFallback: false,
        };
      }
    }
  }

  if (devHeaders !== null) {
    const identity = deriveIdentity({ devHeaders });
    if (identity.ok) {
      return { tokens: null, expired, identity, usingDevFallback: true };
    }
  }

  return {
    tokens: null,
    expired,
    identity: deriveIdentity({}),
    usingDevFallback: false,
  };
}

/** Resolves the acting identity for the current request. */
export async function currentSession(options?: ResolveSessionOptions): Promise<CurrentSession> {
  const { cookies, headers } = await import('next/headers');
  const store = await cookies();
  const jar: CookieReader = { get: (name) => store.get(name)?.value };

  let devHeaders: DevIdentityHeaders | null = null;
  if (DEV_HEADERS_ENABLED) {
    const requestHeaders = await headers();
    devHeaders = {
      tenantId: requestHeaders.get('x-tenant-id'),
      userId: requestHeaders.get('x-user-id'),
      scopes: requestHeaders.get('x-scopes'),
      // Interface mirror only; the API resolves the role from `memberships`.
      role: DEV_IDENTITY.role,
    };
  }

  return resolveSessionFromJar(jar, devHeaders, options);
}

/**
 * Bearer token for the current request, or `null` when there is none.
 *
 * Like `currentSession`, it attempts one lazy renewal when the stored access
 * token is expired: pages and handlers that only need the credential observe
 * the same refreshed value the render would. Unusable here means `null`,
 * exactly as before — callers that own a writable response persist through
 * `ensureFreshAccessToken` directly.
 */
export async function currentAccessToken(
  options?: ResolveSessionOptions,
): Promise<string | null> {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const jar: CookieReader = { get: (name) => store.get(name)?.value };
  const nowMs = options?.nowMs ?? Date.now();

  const stored = decodeSession(jar.get(SESSION_COOKIE));
  if (stored === null) return null;
  if (!sessionIsExpired(stored, nowMs)) return stored.accessToken;

  const renewalOptions =
    options?.fetchImpl === undefined ? { nowMs } : { nowMs, fetchImpl: options.fetchImpl };
  const ensured = await ensureFreshAccessToken(jar, renewalOptions);
  if (ensured.status === 'fresh' || ensured.status === 'refreshed') {
    return ensured.accessToken;
  }
  return null;
}

/** The identity the guard runs against, or `null` when none could be resolved. */
export async function currentIdentity(
  options?: ResolveSessionOptions,
): Promise<IdentityResolution | null> {
  const session = await currentSession(options);
  return session.identity;
}
