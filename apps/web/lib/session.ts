// Server-side session reader.
//
// One place resolves "who is acting" for a Server Component, a Route Handler
// or the proxy. The order is fail-closed and mirrors the tenant middleware:
// a valid session token wins; the local identity headers are consulted only
// when there is no token at all and only outside production; with neither, the
// result is the `tenant.missing` envelope the API would return.
//
// `cookies()` and `headers()` are async in Next 15, so every reader is async
// too — that is also what makes the pages that call them dynamic instead of
// being prerendered with an empty identity.
import { cookies, headers } from 'next/headers';
import { DEV_IDENTITY, SESSION_COOKIE } from './config.ts';
import { DEV_HEADERS_ENABLED } from './server-config.ts';
import { decodeSession, sessionIsExpired, type SessionTokenSet } from './session-codec.ts';
import { deriveIdentity, type IdentityResolution } from './tenant.ts';

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

/** Reads and validates the raw session cookie. */
export async function readSessionCookie(): Promise<SessionTokenSet | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

/** Resolves the acting identity for the current request. */
export async function currentSession(): Promise<CurrentSession> {
  const stored = await readSessionCookie();
  const expired = stored !== null && sessionIsExpired(stored);
  if (stored !== null && !expired) {
    return {
      tokens: stored,
      expired: false,
      identity: deriveIdentity({ token: stored.accessToken }),
      usingDevFallback: false,
    };
  }

  if (DEV_HEADERS_ENABLED) {
    const requestHeaders = await headers();
    const identity = deriveIdentity({
      devHeaders: {
        tenantId: requestHeaders.get('x-tenant-id'),
        userId: requestHeaders.get('x-user-id'),
        scopes: requestHeaders.get('x-scopes'),
        // Interface mirror only; the API resolves the role from `memberships`.
        role: DEV_IDENTITY.role,
      },
    });
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

/** Bearer token for the current request, or `null` when there is none. */
export async function currentAccessToken(): Promise<string | null> {
  const tokens = await readSessionCookie();
  if (tokens === null || sessionIsExpired(tokens)) return null;
  return tokens.accessToken;
}

/** The identity the guard runs against, or `null` when none could be resolved. */
export async function currentIdentity(): Promise<IdentityResolution | null> {
  const session = await currentSession();
  return session.identity;
}
