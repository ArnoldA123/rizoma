// Central authorization guard — formal rule (bases-consolidadas-v1.md §3.1).
// allow(user, action, entity) =
//   user.active AND membership.active AND validity window
//   AND entity.org_node_id in subtree(membership.org_node_id)
//   AND role.permits(action) AND state(entity).allows(action)
//   AND action.module in tenant.modules
// Deny by default. Every denial carries a machine-readable reason and is
// meant to be audited as access.denied with a trace id by the caller.

export interface AccessRequest {
  userActive: boolean;
  membershipActive: boolean;
  now: string; // ISO
  validFrom: string; // ISO
  validTo: string | null; // ISO | null = no expiry
  entityOrgNodeId: string;
  scopeSubtree: string[]; // org_node ids under the membership node (inclusive)
  rolePermits: boolean;
  stateAllows: boolean;
  moduleActive: boolean;
}

export interface AccessDecision {
  allow: boolean;
  reason: string;
}

export function decideAccess(r: AccessRequest): AccessDecision {
  if (!r.userActive) return { allow: false, reason: 'user.inactive' };
  if (!r.membershipActive) return { allow: false, reason: 'membership.inactive' };
  const now = Date.parse(r.now);
  if (Number.isNaN(now)) return { allow: false, reason: 'time.invalid' };
  if (now < Date.parse(r.validFrom)) return { allow: false, reason: 'membership.not_yet_valid' };
  if (r.validTo !== null && now > Date.parse(r.validTo)) {
    return { allow: false, reason: 'membership.expired' };
  }
  if (!r.scopeSubtree.includes(r.entityOrgNodeId)) {
    return { allow: false, reason: 'scope.outside_subtree' };
  }
  if (!r.rolePermits) return { allow: false, reason: 'role.denied' };
  if (!r.stateAllows) return { allow: false, reason: 'state.denied' };
  if (!r.moduleActive) return { allow: false, reason: 'module.inactive' };
  return { allow: true, reason: 'allow' };
}
