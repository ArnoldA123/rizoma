// Server-only configuration (Route Handlers, Server Components, middleware).
//
// Never import this module from a Client Component: it reads variables that
// must not be inlined into the browser bundle. The browser-side counterpart is
// `config.ts`, which only sees `NEXT_PUBLIC_*` values.
//
// Every default is the synthetic local value from `.env.example`, so the demo
// runs with no `.env` file at all and no secret is ever hardcoded.

/** API origin the proxy forwards to (loopback by default, per `main.ts`). */
export const API_ORIGIN = stripTrailingSlash(
  process.env.RIZOMA_API_ORIGIN ?? process.env.NEXT_PUBLIC_API_BASE ?? 'http://127.0.0.1:3001',
);

/** Public origin of this web app; the Keycloak redirect URI is derived from it. */
export const WEB_ORIGIN = stripTrailingSlash(
  process.env.RIZOMA_WEB_ORIGIN ?? 'http://localhost:3000',
);

/** Realm base URL, resolved the same way `apps/api/src/auth/jwt.ts` does. */
export const KEYCLOAK_URL = stripTrailingSlash(
  process.env.KEYCLOAK_URL ?? 'http://localhost:8080',
);

export const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? 'rizoma';

/** Public OIDC client declared in `infra/keycloak/realm-rizoma.json`. */
export const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'rizoma-web';

/** Issuer value the token must carry; the API validates the same string. */
export const KEYCLOAK_ISSUER = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;

/** Exact callback the realm must whitelist (`redirectUris`). */
export const OIDC_REDIRECT_URI = `${WEB_ORIGIN}/api/auth/callback`;

/** Where the user lands after the realm ends the session. */
export const OIDC_POST_LOGOUT_REDIRECT_URI = `${WEB_ORIGIN}/login`;

/** Scopes requested at the authorize endpoint. */
export const OIDC_SCOPES = 'openid profile email';

/** Lifetime of the app session cookie (8 hours, aligned with a work shift). */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Lifetime of the transient PKCE/state cookie (10 minutes). */
export const OIDC_FLOW_MAX_AGE_SECONDS = 10 * 60;

/**
 * Local identity fallback (`x-tenant-id` / `x-user-id` / `x-scopes`).
 *
 * Enabled outside production by default and switchable with
 * `RIZOMA_ALLOW_DEV_HEADERS=false`, so a developer can exercise the shell while
 * Keycloak or the realm client is unavailable. In production it is always off:
 * the fallback headers come from the browser and trusting them there would let
 * anyone choose their own tenant.
 */
export const DEV_HEADERS_ENABLED =
  process.env.NODE_ENV !== 'production' && process.env.RIZOMA_ALLOW_DEV_HEADERS !== 'false';

/** One endpoint under the realm protocol path. */
export function keycloakEndpoint(path: string): string {
  return `${KEYCLOAK_ISSUER}/protocol/openid-connect/${path.replace(/^\/+/, '')}`;
}

/** Upstream URL for one proxied API path (see `resolveUpstreamPath`). */
export function apiUpstreamUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
