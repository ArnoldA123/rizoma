// Keycloak OIDC helpers — Authorization Code flow with PKCE (S256).
//
// Flow shape and why it is a BFF:
// - The browser is redirected to the realm's `authorize` endpoint by
//   `/api/auth/login`, which stores the PKCE verifier and the `state` in a
//   short-lived `HttpOnly` cookie.
// - `/api/auth/callback` performs the `code` → token exchange server-side and
//   stores the token set in an `HttpOnly` session cookie. The browser never
//   sees the access token, and the token endpoint is never called from
//   JavaScript, so no CORS origin has to be added to Keycloak (the realm's
//   `webOrigins` stays exactly as declared).
// - `rizoma-web` is a public client, so PKCE replaces the client secret: no
//   credential is embedded in the bundle or in this repository.
//
// All functions are pure or take an injected `fetch`, so they are testable and
// free of hidden state.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { OIDC_SCOPES } from './server-config.ts';

/** Token response of the realm, normalized to camelCase. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  /** Seconds, as the realm reports it. */
  readonly expiresIn: number;
  readonly tokenType: string;
  readonly scope: string | null;
}

/** Failure while talking to the realm; `code` is machine-readable. */
export class OidcError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
    this.status = status;
  }
}

/** base64url without padding, the encoding PKCE and `state` require. */
export function base64Url(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

/** CSPRNG `state` value. */
export function createState(): string {
  return randomUUID();
}

/** PKCE verifier + S256 challenge pair (RFC 7636). */
export function createPkcePair(byteLength = 32): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(byteLength));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Realm `authorize` URL the browser is sent to. */
export function buildAuthorizeUrl(input: {
  readonly authorizeEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes?: string;
}): string {
  const url = new URL(input.authorizeEndpoint);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes ?? OIDC_SCOPES);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Extract a machine-readable failure from a non-2xx token response. */
async function readRealmError(response: Response): Promise<{ error: string; description: string }> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      error_description?: unknown;
    };
    const error = typeof body.error === 'string' ? body.error : 'oidc_error';
    const description =
      typeof body.error_description === 'string' ? body.error_description : error;
    return { error, description };
  } catch {
    return { error: 'oidc_error', description: `El realm respondió HTTP ${response.status}` };
  }
}

function readTokenSet(body: Record<string, unknown>): TokenSet {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new OidcError('oidc.invalid_token_response', 'La respuesta no trae access_token.');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
    expiresIn,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

/**
 * Shared POST for the realm token endpoint (code exchange and refresh alike).
 * `rizoma-web` is a public client: PKCE or the refresh token authenticates
 * the call, so no client secret is ever sent.
 */
async function postTokenForm(
  endpoint: string,
  form: URLSearchParams,
  rejectionPrefix: string,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OidcError('oidc.unreachable', `Realm inalcanzable: ${detail}`, 502);
  }

  if (!response.ok) {
    const failure = await readRealmError(response);
    throw new OidcError(
      `oidc.${failure.error}`,
      `${rejectionPrefix}: ${failure.description}`,
      401,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  return readTokenSet(body);
}

/** Exchanges an authorization `code` for a token set (PKCE, no secret). */
export async function exchangeCodeForTokens(
  input: {
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  });
  return postTokenForm(
    input.tokenEndpoint,
    form,
    'El realm rechazó el canje del código',
    fetchImpl,
  );
}

/**
 * Renews the token set with `grant_type=refresh_token` (public client, no
 * secret). The realm may rotate the refresh token: callers must persist
 * `refreshToken` again whenever it differs from the one they sent. An
 * `oidc.invalid_grant` failure means the refresh token expired or was
 * revoked, and the session has to end; `oidc.unreachable` is transient and
 * must not clear stored credentials.
 */
export async function refreshAccessTokens(
  input: {
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly refreshToken: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  });
  return postTokenForm(
    input.tokenEndpoint,
    form,
    'El realm rechazó la renovación',
    fetchImpl,
  );
}

/**
 * Realm end-session URL. Keycloak accepts `id_token_hint` and
 * `post_logout_redirect_uri`; the latter must be whitelisted on the client.
 */
export function buildLogoutUrl(input: {
  readonly endSessionEndpoint: string;
  readonly clientId: string;
  readonly postLogoutRedirectUri: string;
  readonly idTokenHint?: string | null;
}): string {
  const url = new URL(input.endSessionEndpoint);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
  if (input.idTokenHint !== null && input.idTokenHint !== undefined && input.idTokenHint !== '') {
    url.searchParams.set('id_token_hint', input.idTokenHint);
  }
  return url.toString();
}
