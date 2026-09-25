// UI access guard — a faithful mirror of the API's authorisation core.
//
// Two modules own the rule on the server side and both are mirrored here, on
// purpose and by name, so a divergence shows up in review:
//   - `apps/api/src/auth/guard.ts`  → {@link decideAccess} (the formal rule of
//     bases-consolidadas-v1.md §3.1, including the exact `reason` strings).
//   - `apps/api/src/auth/policy.ts` → {@link ROLE_PERMISSIONS} and
//     {@link rolePermitsAction} (the role × action matrix, §3.3/§3.4).
//   - `apps/api/src/obras/obras.service.ts#requireSiteAccess` →
//     {@link resolveSiteAccess} (the construction key: active assignment wins,
//     org-scoped managers reach their subtree without one).
//
// This module is the *preemptive* layer: it lets the UI refuse an action and
// render the same `{code, reason, traceId}` envelope the API would emit, so a
// user never sees a route that will certainly fail. It is NOT a security
// boundary — the API remains the only authority, and a browser-side guard can
// always be bypassed. Every decision here is therefore also enforced
// server-side by the endpoint the UI calls.
//
// The module is dependency-free (no React, no `next/*`) so it stays unit
// testable with `node --test` and usable from both Server and Client
// Components.

/** Actions the demo matrix arbitrates — identical list to `policy.ts`. */
export const ACTION_CODES = [
  'agenda.read',
  'patient.read',
  'patient.write',
  'episode.write',
  'appointment.write',
  'invoice.issue',
  'attendance.mark',
  'attendance.approve',
  'stock.consume',
  'site.read',
  'site.write',
  'assignment.write',
] as const;

export type ActionCode = (typeof ACTION_CODES)[number];

/** The 14 realm roles declared in `infra/keycloak/realm-rizoma.json`. */
export const ROLE_CODES = [
  'ti_admin',
  'direccion',
  'medico',
  'enfermeria',
  'recepcion',
  'caja',
  'auditor',
  'gerente',
  'jefe_obra',
  'almacen',
  'capataz',
  'trabajador',
  'vendedor',
  'soporte',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

function grants(...actions: ActionCode[]): ReadonlySet<ActionCode> {
  return new Set(actions);
}

/**
 * Role → granted actions, copied action-by-action from `policy.ts`. Keep the
 * two literal blocks in sync: the load-bearing facts are that `caja` never
 * holds a clinical read, `medico` never holds `invoice.issue`, and
 * `trabajador` holds exactly `attendance.mark` + `site.read`.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, ReadonlySet<ActionCode>> = {
  ti_admin: grants('agenda.read'),
  direccion: grants('agenda.read'),
  medico: grants('agenda.read', 'patient.read', 'patient.write', 'episode.write'),
  enfermeria: grants('agenda.read', 'patient.read'),
  recepcion: grants('agenda.read', 'patient.write', 'appointment.write'),
  caja: grants('invoice.issue'),
  auditor: grants('agenda.read', 'site.read'),
  gerente: grants(
    'attendance.mark',
    'attendance.approve',
    'stock.consume',
    'site.read',
    'site.write',
    'assignment.write',
  ),
  jefe_obra: grants(
    'attendance.mark',
    'attendance.approve',
    'stock.consume',
    'site.read',
    'assignment.write',
  ),
  almacen: grants('attendance.mark', 'stock.consume', 'site.read'),
  capataz: grants('attendance.mark', 'attendance.approve', 'stock.consume', 'site.read'),
  trabajador: grants('attendance.mark', 'site.read'),
  vendedor: grants(),
  soporte: grants(),
};

/** True when `role` is one of the 14 declared realm roles. */
export function isRoleCode(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}

/** True when `action` is one of the twelve arbitrated action codes. */
export function isActionCode(value: string): value is ActionCode {
  return (ACTION_CODES as readonly string[]).includes(value);
}

/**
 * Pure `role.permits(action)` predicate. Unknown role or unknown action denies,
 * which is what makes the negative matrix rows (auditor writing, caja reading
 * history, trabajador approving third parties) explicit rather than accidental.
 */
export function rolePermitsAction(role: string, action: string): boolean {
  if (!isRoleCode(role)) return false;
  if (!isActionCode(action)) return false;
  return ROLE_PERMISSIONS[role].has(action);
}

/** Ordered action grants of one role: the source for rendering the nav. */
export function permittedActions(role: string): readonly ActionCode[] {
  if (!isRoleCode(role)) return [];
  return ACTION_CODES.filter((action) => ROLE_PERMISSIONS[role].has(action));
}

/** Input of the formal rule — field-for-field the API's `AccessRequest`. */
export interface AccessFacts {
  readonly userActive: boolean;
  readonly membershipActive: boolean;
  /** Current instant, ISO-8601. */
  readonly now: string;
  readonly validFrom: string;
  /** ISO-8601 or `null` (no expiry). */
  readonly validTo: string | null;
  readonly entityOrgNodeId: string;
  /** Org node ids under the membership node, inclusive. */
  readonly scopeSubtree: readonly string[];
  readonly rolePermits: boolean;
  readonly stateAllows: boolean;
  readonly moduleActive: boolean;
}

/** Decision shape shared with `guard.ts`. */
export interface AccessDecision {
  readonly allow: boolean;
  readonly reason: string;
}

/**
 * The formal `allow(user, action, entity)` rule (§3.1). Evaluation order is
 * part of the contract: the first failing term names the reason, so the UI
 * shows the same `reason` the API would report for the same state.
 */
export function decideAccess(facts: AccessFacts): AccessDecision {
  if (!facts.userActive) return { allow: false, reason: 'user.inactive' };
  if (!facts.membershipActive) return { allow: false, reason: 'membership.inactive' };
  const now = Date.parse(facts.now);
  if (Number.isNaN(now)) return { allow: false, reason: 'time.invalid' };
  if (now < Date.parse(facts.validFrom)) {
    return { allow: false, reason: 'membership.not_yet_valid' };
  }
  if (facts.validTo !== null && now > Date.parse(facts.validTo)) {
    return { allow: false, reason: 'membership.expired' };
  }
  if (!facts.scopeSubtree.includes(facts.entityOrgNodeId)) {
    return { allow: false, reason: 'scope.outside_subtree' };
  }
  if (!facts.rolePermits) return { allow: false, reason: 'role.denied' };
  if (!facts.stateAllows) return { allow: false, reason: 'state.denied' };
  if (!facts.moduleActive) return { allow: false, reason: 'module.inactive' };
  return { allow: true, reason: 'allow' };
}

/** Roles whose site visibility is bounded by the org subtree, not assignment. */
export const ORG_SCOPED_SITE_ROLES: readonly string[] = ['gerente', 'jefe_obra'];

/** Facts the construction key needs for one site. */
export interface SiteAccessFacts {
  readonly role: string;
  readonly siteId: string;
  readonly entityOrgNodeId: string;
  readonly scopeSubtree: readonly string[];
  /** Site ids the user holds an `active` assignment for. */
  readonly assignedSiteIds: readonly string[];
  readonly userActive?: boolean;
  readonly membershipActive?: boolean;
  readonly now?: string;
  readonly validFrom?: string;
  readonly validTo?: string | null;
  readonly moduleActive?: boolean;
  readonly stateAllows?: boolean;
  /** Assignment is the key: an assigned site is reachable without site.read. */
  readonly hasSiteRead?: boolean;
}

/**
 * Resolves site access exactly like `requireSiteAccess`: the central rule runs
 * first (membership, subtree, `site.read`, module), then an active assignment
 * grants access, then an org-scoped manager reaches a site inside its subtree.
 * Anything else is denied with `no_active_assignment` — the same token the API
 * puts in the `obra.scope_denied` envelope, which is what makes "jefe solo sus
 * obras" and "trabajador fuera de obra no marca" visible before the request.
 */
export function resolveSiteAccess(facts: SiteAccessFacts): AccessDecision {
  const decision = decideAccess({
    userActive: facts.userActive ?? true,
    membershipActive: facts.membershipActive ?? true,
    now: facts.now ?? new Date().toISOString(),
    validFrom: facts.validFrom ?? new Date(0).toISOString(),
    validTo: facts.validTo ?? null,
    entityOrgNodeId: facts.entityOrgNodeId,
    scopeSubtree: facts.scopeSubtree,
    rolePermits: facts.hasSiteRead ?? rolePermitsAction(facts.role, 'site.read'),
    stateAllows: facts.stateAllows ?? true,
    moduleActive: facts.moduleActive ?? true,
  });
  if (!decision.allow) return decision;

  if (facts.assignedSiteIds.includes(facts.siteId)) {
    return { allow: true, reason: 'allow' };
  }
  if (ORG_SCOPED_SITE_ROLES.includes(facts.role)) {
    return { allow: true, reason: 'allow' };
  }
  return { allow: false, reason: 'no_active_assignment' };
}

// ============ route-level guard ============

/** How a route's required actions combine. */
export type RequirementMode = 'any' | 'all';

/**
 * One route's access rule. `any` is used where a single screen hosts actions
 * from two different grants — `/salud/pacientes` lists files (`patient.read`)
 * and registers new ones (`patient.write`), and `recepcion` legitimately holds
 * only the second. The page then gates each capability separately, so the
 * route is reachable without over-granting either action.
 */
export interface RouteRequirements {
  readonly path: string;
  readonly actions: readonly ActionCode[];
  readonly mode: RequirementMode;
}

/** Result of evaluating a route rule for one role. */
export interface RouteDecision {
  readonly allow: boolean;
  readonly reason: string;
  /** Actions of the rule the role does hold — drives in-page gating. */
  readonly permitted: readonly ActionCode[];
  /** Actions of the rule the role does not hold. */
  readonly denied: readonly ActionCode[];
}

/**
 * Evaluates a route rule for `role`. The returned `reason` is always the API's
 * `role.denied` when the role lacks a requirement, so the UI denial is
 * indistinguishable from the API denial in shape and in wording.
 */
export function decideRouteAccess(role: string, rule: RouteRequirements): RouteDecision {
  const permitted = rule.actions.filter((action) => rolePermitsAction(role, action));
  const denied = rule.actions.filter((action) => !rolePermitsAction(role, action));
  // An empty requirement is an open route (home, login): nothing to arbitrate.
  const allow =
    rule.actions.length === 0
      ? true
      : rule.mode === 'any'
        ? permitted.length > 0
        : denied.length === 0;
  return {
    allow,
    reason: allow ? 'allow' : 'role.denied',
    permitted,
    denied,
  };
}

/** Stable correlation id for a denial or a client-originated mutation. */
export function newTraceId(): string {
  return `web-${globalThis.crypto.randomUUID()}`;
}
