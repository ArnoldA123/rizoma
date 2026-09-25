// Browser-safe configuration and shared protocol constants.
//
// Rule: this module is imported by client components, so it may only read
// `NEXT_PUBLIC_*` variables (inlined at build time by Next). Everything that
// touches a server-only value — the API origin, the Keycloak issuer, the
// session cookie — lives in `server-config.ts` and is imported by Route
// Handlers, Server Components and `middleware.ts` only.

/** Same-origin proxy prefix the browser uses for every API call. */
export const PROXY_BASE_PATH = '/api/proxy';

/** Version prefix of the REST surface, mirrored from `main.ts` (`/v1`). */
export const API_VERSION_PREFIX = '/v1';

/** Correlation header shared with the API and its logs. */
export const TRACE_ID_HEADER = 'x-trace-id';

/** Idempotency header the critical POST routes require. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Tenant id header — local development fallback only. */
export const TENANT_ID_HEADER = 'x-tenant-id';

/** Acting user id header — local development fallback only. */
export const USER_ID_HEADER = 'x-user-id';

/** Granted scopes header — local development fallback only. */
export const SCOPES_HEADER = 'x-scopes';

/** Authorisation header the proxy injects from the session cookie. */
export const AUTHORIZATION_HEADER = 'authorization';

/** Session cookie: holds the Keycloak token set, `HttpOnly`. */
export const SESSION_COOKIE = 'rizoma_session';

/**
 * Transient cookie carrying the PKCE verifier, the `state` and the post-login
 * path between `/api/auth/login` and `/api/auth/callback`.
 */
export const OIDC_FLOW_COOKIE = 'rizoma_oidc';

/** Persisted colour-scheme preference (`light` | `dark`). */
export const THEME_COOKIE = 'rizoma_theme';

/** Persisted decorative-grid preference (`on` | `off`). */
export const GRID_COOKIE = 'rizoma_grid';

/**
 * Request header the middleware stamps with the pathname. Server Components
 * have no pathname API, and the shell needs it to pick the active section and
 * its skin from the same route table the guard reads.
 */
export const PATH_HEADER = 'x-rizoma-path';

/**
 * Local development identity shipped to the proxy when there is no Keycloak
 * session. Empty by default: the dev path is opt-in and every value has to be
 * present before the proxy uses it.
 *
 * Why a role is part of it: the API resolves the acting role from `memberships`
 * in the database, not from a header, so a token-less browser has no way to
 * learn its own role until a membership endpoint exists. `NEXT_PUBLIC_DEV_ROLE`
 * supplies it for the interface mirror only — the API still authorises against
 * the real membership, which is why a forged role here can mislead the screen
 * but never grant access to data.
 */
export const DEV_IDENTITY = {
  /** `true` turns the local fallback on; anything else keeps it off. */
  enabled: process.env.NEXT_PUBLIC_ALLOW_DEV_HEADERS === 'true',
  tenantId: process.env.NEXT_PUBLIC_DEV_TENANT_ID ?? '',
  userId: process.env.NEXT_PUBLIC_DEV_USER_ID ?? '',
  scopes: process.env.NEXT_PUBLIC_DEV_SCOPES ?? '',
  /** One realm role, e.g. `medico`. Interface mirror only. */
  role: process.env.NEXT_PUBLIC_DEV_ROLE ?? '',
  /**
   * Sede the Salud forms prefill their `orgNodeId` field with.
   *
   * Why a prefill and not a lookup: MVP1 exposes no org-node listing endpoint
   * (the dashboards take `?org=` as a UUID and nothing returns the nodes of the
   * caller's subtree), so the registration and scheduling forms have to carry
   * the sede as an explicit identifier. This value only spares the demo operator
   * from pasting it by hand; it is never trusted as an authorisation fact — the
   * API scopes the write to it and decides on its own membership. Every screen
   * also remembers the last sede it read from a real row, so the field fills
   * itself as soon as the API answers.
   */
  orgNodeId: process.env.NEXT_PUBLIC_DEV_ORG_NODE_ID ?? '',
} as const;

/** True when the local identity fallback is fully configured. */
export function devIdentityConfigured(): boolean {
  return (
    DEV_IDENTITY.enabled &&
    DEV_IDENTITY.tenantId !== '' &&
    DEV_IDENTITY.userId !== ''
  );
}
