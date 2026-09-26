// Tenant and identity derivation for the web app.
//
// This is the browser/UI mirror of the API's identity path:
//   - `apps/api/src/auth/jwt.ts` builds the same claim reading order
//     (`tenant_id`, then `azp`; `realm_access.roles`, then `roles`;
//     space-delimited `scope`, then the `scp` array).
//   - `apps/api/src/tenant/tenant.middleware.ts` owns the validation gates:
//     the tenant id must be a UUID v4, the acting user id must be a UUID, and
//     the local `x-tenant-id` / `x-user-id` / `x-scopes` headers are a
//     development-only fallback that is never used when a token is presented
//     (fail closed).
//
// The token is decoded, never verified here: verification is the API's job and
// the browser has no reason to hold the realm public key. Decoding is only
// used to render the session and to preempt a request the API would certainly
// deny — it is not a security boundary.
//
// Dependency-free on purpose (no React, no `next/*`) so it is unit testable
// with `node --test` and usable from Server and Client Components alike.
import { isRoleCode, type RoleCode } from './access.ts';

/** Preferred tenant claim; emitted by the realm protocol mapper. */
export const CLAIM_TENANT = 'tenant_id';
/** Fallback tenant claim: the OIDC authorized party (one client per tenant). */
export const CLAIM_TENANT_FALLBACK = 'azp';
/** Keycloak realm role container. */
export const CLAIM_REALM_ACCESS = 'realm_access';

/** Same shape the API enforces for `x-tenant-id` / the tenant claim. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Same shape the API enforces for `x-user-id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_SEPARATOR_RE = /[\s,]+/;

/** Identity as the UI carries it after a successful resolution. */
export interface DerivedIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  /** Which source produced the identity — surfaced in the session card. */
  readonly source: 'token' | 'dev-headers';
}

/** Identity-resolution failures, named with the API's own error codes. */
export type IdentityErrorCode =
  | 'auth.token_invalid'
  | 'tenant.missing'
  | 'tenant.user_invalid';

export type IdentityResolution =
  | { readonly ok: true; readonly identity: DerivedIdentity }
  | {
      readonly ok: false;
      readonly code: IdentityErrorCode;
      readonly reason: string;
      readonly message: string;
    };

/** Development-only identity headers the proxy may fall back to. */
export interface DevIdentityHeaders {
  readonly tenantId?: string | null;
  readonly userId?: string | null;
  readonly scopes?: string | null;
  /**
   * Role for the interface mirror, from `NEXT_PUBLIC_DEV_ROLE`. The API never
   * receives it: it resolves the acting role from `memberships`.
   */
  readonly role?: string | null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
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

/** base64url payload decode; returns `null` for anything malformed. */
function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + '='.repeat(padLength));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decodes the payload of a compact JWS without verifying it. Returns `null`
 * when the token is not a three-segment compact token or its payload is not a
 * JSON object.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) return null;
  const payload = parts[1];
  if (payload === undefined) return null;
  return decodeBase64UrlJson(payload);
}

/** Seconds-since-epoch `exp`, or `null` when the claim is missing/invalid. */
export function tokenExpiresAt(token: string): number | null {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

/** True when the token is absent, malformed or past its `exp`. */
export function isTokenExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = tokenExpiresAt(token);
  if (exp === null) return true;
  return nowMs >= exp * 1000;
}

/** `realm_access.roles`, with a flat `roles` claim as fallback. */
export function readRoles(payload: Record<string, unknown>): string[] {
  const realmAccess = payload[CLAIM_REALM_ACCESS];
  if (realmAccess !== null && typeof realmAccess === 'object' && !Array.isArray(realmAccess)) {
    const roles = readStringArray((realmAccess as Record<string, unknown>).roles);
    if (roles.length > 0) return [...new Set(roles)];
  }
  return [...new Set(readStringArray(payload.roles))];
}

/** Splits a scope list on whitespace or commas, dropping empty segments. */
export function splitScopes(raw: string | null | undefined): string[] {
  const value = readString(raw ?? undefined);
  if (value === undefined) return [];
  return [...new Set(value.split(SCOPE_SEPARATOR_RE).filter((scope) => scope !== ''))];
}

/** OAuth scopes: space-delimited `scope`, with the `scp` array as fallback. */
export function readScopes(payload: Record<string, unknown>): string[] {
  const scope = readString(payload.scope);
  if (scope !== undefined) return splitScopes(scope);
  return [...new Set(readStringArray(payload.scp))];
}

/** Primary tenant claim, then `azp` — the API's exact fallback order. */
export function readTenantClaim(
  payload: Record<string, unknown>,
  tenantClaim: string = CLAIM_TENANT,
): string | undefined {
  return readString(payload[tenantClaim]) ?? readString(payload[CLAIM_TENANT_FALLBACK]);
}

/**
 * Resolves the acting identity from a presented access token or, only when no
 * token is presented, from the local development headers.
 *
 * Fail-closed contract, mirrored from the tenant middleware: a presented token
 * that cannot be decoded is rejected with `auth.token_invalid`; the header path
 * is never consulted as a fallback for it.
 */
export function deriveIdentity(input: {
  readonly token?: string | null;
  readonly devHeaders?: DevIdentityHeaders;
}): IdentityResolution {
  const token = readString(input.token ?? undefined);

  if (token !== undefined) {
    const payload = decodeJwtPayload(token);
    if (payload === null) {
      return {
        ok: false,
        code: 'auth.token_invalid',
        reason: 'token.malformed',
        message: 'No pudimos leer su sesión. Entre de nuevo.',
      };
    }
    const tenantClaim = readTenantClaim(payload);
    if (tenantClaim === undefined || !UUID_V4_RE.test(tenantClaim)) {
      return {
        ok: false,
        code: 'tenant.missing',
        reason: 'tenant.missing',
        message: 'No encontramos su organización. Entre de nuevo o avise a soporte.',
      };
    }
    const userId = readString(payload.sub);
    if (userId === undefined || !UUID_RE.test(userId)) {
      return {
        ok: false,
        code: 'tenant.user_invalid',
        reason: 'tenant.user_invalid',
        message: 'No encontramos su usuario. Entre de nuevo o avise a soporte.',
      };
    }
    return {
      ok: true,
      identity: {
        tenantId: tenantClaim,
        userId,
        roles: readRoles(payload),
        scopes: readScopes(payload),
        source: 'token',
      },
    };
  }

  const dev = input.devHeaders ?? {};
  const devTenant = readString(dev.tenantId ?? undefined);
  const devUser = readString(dev.userId ?? undefined);
  if (devTenant === undefined || devUser === undefined) {
    return {
      ok: false,
      code: 'tenant.missing',
      reason: 'tenant.missing',
      message: 'Sin sesión. Entre con su cuenta para continuar.',
    };
  }
  if (!UUID_V4_RE.test(devTenant)) {
    return {
      ok: false,
      code: 'tenant.missing',
      reason: 'tenant.missing',
      message: 'La identidad local no es válida. Avise a soporte.',
    };
  }
  if (!UUID_RE.test(devUser)) {
    return {
      ok: false,
      code: 'tenant.user_invalid',
      reason: 'tenant.user_invalid',
      message: 'La identidad local no es válida. Avise a soporte.',
    };
  }
  const devRole = readString(dev.role ?? undefined);
  return {
    ok: true,
    identity: {
      tenantId: devTenant,
      userId: devUser,
      roles: devRole === undefined ? [] : [devRole],
      scopes: splitScopes(dev.scopes ?? undefined),
      source: 'dev-headers',
    },
  };
}

/** Roles of the identity that are declared realm roles, in realm order. */
export function knownRoles(identity: DerivedIdentity): readonly RoleCode[] {
  return identity.roles.filter(isRoleCode);
}

/**
 * The single role the UI drives the nav with. Keycloak grants are additive in
 * the token, but the API resolves exactly one membership role per tenant, so
 * the UI picks the same way the API would: the first declared realm role in
 * token order. `null` means the token carries no realm role at all.
 */
export function primaryRole(identity: DerivedIdentity): RoleCode | null {
  return knownRoles(identity)[0] ?? null;
}
