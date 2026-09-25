// Lazy access-token renewal for the web BFF — pure except for the injected
// `fetch`, so it is unit testable with `node --test`.
//
// Cookie split and why: the session cookie keeps the slim shape (`accessToken`
// + `expiresAt` + `tokenType`, ~2KB), so the Edge middleware and every
// existing reader keep working unchanged, and the refresh material lives in a
// second `HttpOnly`, `SameSite=Lax` cookie (`REFRESH_COOKIE`). Each cookie
// stays well under the ~4KB practical per-cookie limit — the combination that
// used to travel together measured ~2.9KB and already lost the race against
// browser limits once.
//
// Renewal is lazy: `ensureFreshAccessToken` returns the stored access token
// when it is still valid (30s safety margin from `sessionIsExpired`) and only
// calls the realm with `grant_type=refresh_token` when the access token is
// expired or about to expire. Concurrent callers sharing one refresh token
// share one in-flight realm round-trip (singleflight); the map entry is
// dropped as soon as the round-trip settles, so a failure never poisons later
// calls.
//
// Failure contract: the realm rejecting the refresh (`invalid_grant` and
// friends) means the grant expired or was revoked, and the handler must clear
// both cookies so the next page load falls through to `/login`. A realm that
// cannot be reached is transient and must NOT clear stored credentials.
import { SESSION_COOKIE } from './config.ts';
import { OidcError, refreshAccessTokens, type TokenSet } from './oidc.ts';
import {
  KEYCLOAK_CLIENT_ID,
  SESSION_MAX_AGE_SECONDS,
  keycloakEndpoint,
} from './server-config.ts';
import {
  REFRESH_COOKIE,
  decodeRefresh,
  decodeSession,
  encodeRefresh,
  encodeSession,
  sessionIsExpired,
  type RefreshStore,
} from './session-codec.ts';

/**
 * Refresh cookie name and codec, re-exported from the Edge-safe
 * `session-codec.ts`. The Edge middleware gates on them (see
 * `hasRenewableSession`), so they cannot live here: this module pulls
 * `node:crypto` via `oidc.ts`, which must stay out of the Edge bundle.
 * Route Handlers keep importing them from here unchanged.
 */
export { REFRESH_COOKIE, decodeRefresh, encodeRefresh, type RefreshStore };

/** Minimal cookie access the renewal needs; keeps `next/*` out of this module. */
export interface CookieReader {
  get(name: string): string | undefined;
}

/** What a handler must persist after a successful renewal. */
export interface PersistedRefresh {
  readonly sessionCookieValue: string;
  /** Non-null only when the realm rotated the refresh token. */
  readonly refreshCookieValue: string | null;
  readonly maxAgeSeconds: number;
}

export type FreshAccessResult =
  | { readonly status: 'fresh'; readonly accessToken: string }
  | ({ readonly status: 'refreshed'; readonly accessToken: string } & PersistedRefresh)
  | {
      readonly status: 'unauthorized';
      readonly reason:
        | 'no-session'
        | 'refresh-missing'
        | 'refresh-failed'
        | 'refresh-unreachable';
      /** True when stale credentials exist and the handler must clear them. */
      readonly clearCookies: boolean;
    };

/** In-flight realm round-trips keyed by the refresh token that started them. */
const inflightRefreshes = new Map<string, Promise<TokenSet>>();

/**
 * One realm round-trip per refresh token, shared by concurrent callers.
 * `rizoma-web` is a public client, so no secret is sent.
 */
export function singleflightRefresh(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const pending = inflightRefreshes.get(refreshToken);
  if (pending !== undefined) return pending;
  const task = refreshAccessTokens(
    {
      tokenEndpoint: keycloakEndpoint('token'),
      clientId: KEYCLOAK_CLIENT_ID,
      refreshToken,
    },
    fetchImpl,
  ).finally(() => {
    if (inflightRefreshes.get(refreshToken) === task) inflightRefreshes.delete(refreshToken);
  });
  inflightRefreshes.set(refreshToken, task);
  return task;
}

/** Test hook: refreshes currently in flight (drains to zero after settling). */
export function inflightRefreshCount(): number {
  return inflightRefreshes.size;
}

/**
 * Resolves a usable access token for a handler. Returns the stored token when
 * it is still valid; renews it with the refresh token when it is expired or
 * within the 30s safety margin; reports `unauthorized` when there is nothing
 * to renew with or the realm rejected the grant. Handlers persist
 * `PersistedRefresh` on their response and clear both cookies when
 * `clearCookies` is true.
 */
export async function ensureFreshAccessToken(
  jar: CookieReader,
  options?: { readonly nowMs?: number; readonly fetchImpl?: typeof fetch },
): Promise<FreshAccessResult> {
  const nowMs = options?.nowMs ?? Date.now();
  const fetchImpl = options?.fetchImpl ?? fetch;

  const stored = decodeSession(jar.get(SESSION_COOKIE));
  if (stored !== null && !sessionIsExpired(stored, nowMs)) {
    return { status: 'fresh', accessToken: stored.accessToken };
  }

  const refresh = decodeRefresh(jar.get(REFRESH_COOKIE));
  if (refresh === null) {
    return {
      status: 'unauthorized',
      reason: stored === null ? 'no-session' : 'refresh-missing',
      clearCookies: stored !== null,
    };
  }

  let renewed: TokenSet;
  try {
    renewed = await singleflightRefresh(refresh.refreshToken, fetchImpl);
  } catch (error) {
    if (error instanceof OidcError && error.code === 'oidc.unreachable') {
      return { status: 'unauthorized', reason: 'refresh-unreachable', clearCookies: false };
    }
    return { status: 'unauthorized', reason: 'refresh-failed', clearCookies: true };
  }

  const nextRefreshToken =
    renewed.refreshToken === null || renewed.refreshToken === refresh.refreshToken
      ? null
      : renewed.refreshToken;
  return {
    status: 'refreshed',
    accessToken: renewed.accessToken,
    sessionCookieValue: encodeSession({
      accessToken: renewed.accessToken,
      expiresAt: nowMs + renewed.expiresIn * 1000,
      tokenType: renewed.tokenType,
    }),
    refreshCookieValue:
      nextRefreshToken === null
        ? null
        : encodeRefresh({ refreshToken: nextRefreshToken, idToken: renewed.idToken }),
    maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
  };
}
