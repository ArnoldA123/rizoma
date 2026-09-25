// Session cookie codec — pure, no `next/*` import, so it is reachable from
// `middleware.ts` (Edge runtime) and from Server Components alike, and testable
// with `node --test`.
//
// Storage decision: the session lives in one `HttpOnly`, `SameSite=Lax`
// cookie, encoded as base64url JSON. That is the canonical BFF shape — the
// access token never reaches JavaScript, so an XSS in the UI cannot exfiltrate
// it, and the proxy can attach it server-side. The value is not encrypted, so
// the cookie is the credential: it must stay `HttpOnly` and `Secure` outside
// local development (see `sessionCookieOptions`).
//
// The cookie carries the slim session only (`accessToken` + `expiresAt` +
// `tokenType`). Refresh and ID tokens used to travel in it too and roughly
// tripled its size (~2.9KB), which lost the race against browser per-cookie
// limits after the OIDC callback redirect — the `Set-Cookie` never stuck and
// `/` kept answering `tenant.missing`. They now live in a second `HttpOnly`
// cookie (`REFRESH_COOKIE`, declared below), so each cookie stays well
// under the ~4KB practical limit. Neither token feeds identity (only the
// access token does), and `decodeSession` still reads cookies written in the
// old full shape.
//
// The encoding avoids `Buffer`/base64 so the module stays Edge-compatible.

/** Token set as held after decoding the session cookie. */
export interface SessionTokenSet {
  readonly accessToken: string;
  /**
   * Legacy fields, populated only when reading a cookie written before the
   * slimming. `encodeSession` no longer writes them: neither feeds identity
   * (only the access token does) and both roughly tripled the cookie size.
   */
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  /** Absolute expiry in milliseconds since epoch. */
  readonly expiresAt: number;
  readonly tokenType: string;
}

/** Slim session payload — the only shape `encodeSession` writes. */
export interface SlimSession {
  readonly accessToken: string;
  /** Absolute expiry in milliseconds since epoch. */
  readonly expiresAt: number;
  readonly tokenType: string;
}

/** Transient PKCE + `state` payload carried between login and callback. */
export interface OidcFlowState {
  readonly state: string;
  readonly codeVerifier: string;
  /** In-app path to resume after a successful login. */
  readonly next: string;
}

function encodeJson(value: unknown): string {
  return encodeCookiePayload(value);
}

function decodeJson(raw: string): unknown {
  return decodeCookiePayload(raw);
}

/**
 * base64url JSON for cookie payloads. Shared with `refresh.ts` so both
 * cookies use the same alphabet; it avoids `Buffer`/base64 so the module
 * stays Edge-compatible.
 */
export function encodeCookiePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCookiePayload(raw: string): unknown {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + '='.repeat(padLength));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value === '' ? undefined : value;
}

/**
 * Serializes the slim session for the cookie: access token + expiry + type.
 * Refresh and ID tokens are deliberately left out — they never feed identity
 * and keeping them pushed the cookie past what browsers reliably persist
 * after the callback redirect. They are persisted separately in
 * `REFRESH_COOKIE` (declared below). The object is built field by field (never
 * spread) so a full token set passed in by mistake still encodes slim.
 */
export function encodeSession(tokens: SlimSession): string {
  return encodeJson({
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
  });
}

/**
 * Parses a session cookie value; `null` for absent, malformed or partial data.
 * Reads both shapes: the current slim payload and the legacy full payload
 * (with `refreshToken`/`idToken`), so cookies written before the slimming
 * keep working until they expire.
 */
export function decodeSession(raw: string | undefined | null): SessionTokenSet | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = decodeJson(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const accessToken = readString(record.accessToken);
  const expiresAt = record.expiresAt;
  if (accessToken === undefined) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return {
    accessToken,
    refreshToken: readString(record.refreshToken) ?? null,
    idToken: readString(record.idToken) ?? null,
    expiresAt,
    tokenType: readString(record.tokenType) ?? 'Bearer',
  };
}

/**
 * True when the token set is past its expiry. A 30 second safety margin keeps
 * a request from being sent with a token that expires mid-flight.
 */
export function sessionIsExpired(
  tokens: SlimSession,
  nowMs: number = Date.now(),
  skewMs = 30_000,
): boolean {
  return nowMs >= tokens.expiresAt - skewMs;
}

/**
 * Second session cookie holding the refresh material. Declared here (not in
 * `refresh.ts`) so the Edge middleware can gate on it without importing the
 * realm client: `refresh.ts` pulls `node:crypto` via `oidc.ts`, which must
 * stay out of the Edge bundle. `refresh.ts` re-exports this constant and the
 * codec below, so Route Handlers keep importing them from there unchanged.
 *
 * Read by the Route Handlers that can renew (`proxy`, `session`) and by
 * `logout` for the end-session `id_token_hint`; never sent to the browser JS
 * (`HttpOnly`). The Edge middleware reads it only to decide the
 * expired-but-renewable pass-through (see `hasRenewableSession`) — renewal
 * itself still happens in Node, via `ensureFreshAccessToken`.
 */
export const REFRESH_COOKIE = 'rizoma_refresh';

/** Refresh material persisted between renewals. */
export interface RefreshStore {
  readonly refreshToken: string;
  /** Kept for the end-session `id_token_hint`; never feeds identity. */
  readonly idToken: string | null;
}

/** Serializes the refresh material for `REFRESH_COOKIE`. */
export function encodeRefresh(store: RefreshStore): string {
  return encodeCookiePayload({
    refreshToken: store.refreshToken,
    idToken: store.idToken,
  });
}

/** Parses `REFRESH_COOKIE`; `null` for absent, malformed or partial data. */
export function decodeRefresh(raw: string | undefined | null): RefreshStore | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = decodeCookiePayload(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const refreshToken = record.refreshToken;
  if (typeof refreshToken !== 'string' || refreshToken === '') return null;
  const idToken = record.idToken;
  return {
    refreshToken,
    idToken: typeof idToken === 'string' && idToken !== '' ? idToken : null,
  };
}

/**
 * True when the request carries an expired session cookie plus a structurally
 * valid refresh grant. The Edge gate uses this to let the request through for
 * lazy downstream renewal instead of bouncing to `/login`.
 *
 * Fail-closed by construction: a missing or malformed session is never
 * renewable (anonymous traffic keeps the `/login` redirect), a fresh session
 * returns false (it takes the fast path above this check), and a missing or
 * malformed refresh grant returns false. Structural validity is not proof the
 * realm will accept the grant — a rejected refresh still clears both cookies
 * downstream, so the next load lands on `/login` anyway.
 */
export function hasRenewableSession(
  sessionRaw: string | undefined | null,
  refreshRaw: string | undefined | null,
  nowMs: number = Date.now(),
): boolean {
  const stored = decodeSession(sessionRaw);
  if (stored === null || !sessionIsExpired(stored, nowMs)) return false;
  return decodeRefresh(refreshRaw) !== null;
}

/** Serializes the transient login-callback state. */
export function encodeFlow(flow: OidcFlowState): string {
  return encodeJson(flow);
}

/** Parses the transient login-callback state; `null` when incomplete. */
export function decodeFlow(raw: string | undefined | null): OidcFlowState | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = decodeJson(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const state = readString(record.state);
  const codeVerifier = readString(record.codeVerifier);
  if (state === undefined || codeVerifier === undefined) return null;
  return { state, codeVerifier, next: readString(record.next) ?? '/' };
}

/**
 * Cookie attributes shared by every response that sets the session.
 * `secure` is on whenever the public origin is HTTPS, which is what keeps the
 * credential off plaintext transport outside local development.
 */
export function sessionCookieOptions(webOrigin: string, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: webOrigin.startsWith('https://'),
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
