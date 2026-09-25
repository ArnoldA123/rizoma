// Central access guard (bases-consolidadas-v1.md §3.1, §3.5, §4.4).
//
// `decideAccess` in `./guard.ts` owns the formal rule and stays pure. This
// module is the wiring A3 adds around it:
// - `canActivate` builds the rule input from the verified identity and the
//   caller-supplied membership/entity/module facts, asks `decideAccess`, and on
//   denial appends one `access.denied` row to `audit_log` (append-only) through
//   the tenant client already bound to the request — the same transaction whose
//   `app.tenant_id` RLS context the row must observe.
// - `loadMembership` reads the caller's membership for the tenant.
//
// Audit row discipline: `audit_log` has no `trace_id` column, so the
// correlation id travels inside `diff` JSONB as `traceId`, together with the
// deny reason, the attempted action, the role and the entity node. `tenant_id`
// is the membership tenant when present, otherwise the token's tenant claim.
//
// Field notes against the A3 sketch: the rule needs `rolePermits` and
// `users.active`, which no other input carries. `rolePermits` is therefore
// required and computed by the endpoint policy layer from `membership.role` +
// `identity.roles` (see `./policy.ts`); `loadMembership` now resolves
// `users.active` in the same query through a JOIN, so the real value feeds
// `userActive` and the historical default-true only survives for callers that
// build a membership record by hand (unit contexts and fixtures).
//
// Permission-cache contract (§3.1 property 5): the guard keeps no permission
// cache. `PERMISSION_CACHE_TTL_MS` documents that the effective TTL is zero,
// so every request re-reads `memberships` + `users` and an onboarding/offboard
// takes effect on the next decision — the end-to-end <5-minute revocation is
// therefore a property of the read path, not of a background expiry. The
// measured revocation probe lives in `scripts/probes/api_probes.sh`.
//
// Fail-closed on audit failure: if the `access.denied` insert rejects, the
// error propagates instead of returning a silent 403, because an unaudited
// denial would violate §4.4.
//
// Denial org node (MVP1 W2F): `audit_log.org_node_id` is a FK to `org_nodes`
// (001_core_foundation.sql) and the tenant id is not a node id. A caller
// without a membership used to reach this insert with the tenant id as a
// placeholder (`facts.membership?.orgNodeId ?? actor.tenantId`), so Postgres
// raised SQLSTATE 23503, the insert failure propagated fail-closed and the
// caller got an untyped 500 instead of the typed 403 envelope. The guard now
// normalizes an unknown node to NULL and resolves the recorded value through
// `org_nodes`, so the denial row is always written and the caller keeps its
// typed 403. Every other audit failure (permissions, RLS, connection) still
// propagates.
import { decideAccess, type AccessDecision, type AccessRequest } from './guard.ts';
import type { Identity } from './jwt.ts';

/** Action recorded for every denied attempt. */
export const ACCESS_DENIED_ACTION = 'access.denied';

/**
 * Effective permission-cache TTL. Zero: the guard reads `memberships` and
 * `users` per request, so a deactivation between two requests is observed by
 * the second one. Kept as a named constant so the contract is explicit and
 * greppable, and so a future cache cannot be added silently (§3.1 property 5).
 */
export const PERMISSION_CACHE_TTL_MS = 0;

/** Minimal query surface (satisfied by a pooled `pg` client). */
export interface AuditClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Where the denial is recorded: the request client plus correlation context. */
export interface AuditContext {
  readonly client: AuditClient;
  /** Correlation id shared with logs/traces (`x-trace-id`). */
  readonly traceId: string;
  /** Entity kind the caller attempted to touch (e.g. `patient_file`). */
  readonly entity: string;
  readonly entityId?: string | null;
  /**
   * Org node the caller attempted to touch. Must be a real `org_nodes.id`:
   * `null`, `undefined` and the tenant id are all recorded as NULL, because
   * `audit_log.org_node_id` is a FK to `org_nodes`.
   */
  readonly orgNodeId?: string | null;
  readonly attemptedAction?: string;
  readonly ip?: string | null;
}

/** One `memberships` row, camelCased for the rule input. */
export interface MembershipRecord {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly orgNodeId: string;
  readonly role: string;
  readonly scopes: readonly string[];
  readonly active: boolean;
  readonly validFrom: string;
  readonly validTo: string | null;
  /**
   * `users.active` for the membership owner, resolved by the JOIN in
   * {@link loadMembership}. Optional so hand-built records (pure unit
   * contexts) keep working; the guard then falls back to `true`.
   */
  readonly userActive?: boolean;
}

/** Everything the guard needs for one decision. */
export interface GuardContext {
  readonly identity: Identity;
  /** Caller's membership for `identity.tenantId`; null means none exists. */
  readonly membership: MembershipRecord | null;
  readonly entityOrgNodeId: string;
  readonly scopeSubtree: readonly string[];
  /** Computed by the endpoint policy layer from role + action. */
  readonly rolePermits: boolean;
  readonly stateAllows: boolean;
  readonly moduleActive: boolean;
  /**
   * `users.active`. When omitted the guard uses the value resolved by the
   * `loadMembership` JOIN, then defaults to true for hand-built contexts.
   */
  readonly userActive?: boolean;
  /** Injectable clock (ISO); defaults to the real clock. */
  readonly now?: string;
  readonly audit: AuditContext;
}

/**
 * Reads (at most) one membership for the caller in the tenant, preferring an
 * active and recent row so the guard can still explain an inactive/expired one.
 * The same statement joins `users` to resolve `active` in one round trip, so a
 * single query supplies both the membership and the owner's activation state.
 */
const SELECT_MEMBERSHIP_SQL = `SELECT m.id, m.user_id, m.tenant_id, m.org_node_id, m.role, m.scopes, m.active, m.valid_from, m.valid_to, u.active AS user_active
FROM memberships m
JOIN users u ON u.id = m.user_id
WHERE m.user_id = $1 AND m.tenant_id = $2
ORDER BY m.active DESC, m.valid_from DESC
LIMIT 1`;

/**
 * Appends the denial to the append-only audit trail.
 *
 * The org node is resolved through `org_nodes` instead of being stored
 * verbatim: the column is a FK to that table, so an unknown, stale or foreign
 * node id would abort the insert (SQLSTATE 23503) and take the whole request
 * transaction with it. The scalar subquery degrades an unresolvable node to
 * NULL — which the column allows — so the denial stays audited and the caller
 * keeps the typed 403 envelope. The tenant id never resolves (it lives in
 * `tenants`, not in `org_nodes`).
 */
const INSERT_ACCESS_DENIED_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, (SELECT id FROM org_nodes WHERE id = $6), $7::jsonb, $8)`;

interface QueryResultLike {
  readonly rows?: readonly Record<string, unknown>[];
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
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

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

/** `pg` hands timestamptz back as `Date`; normalize to ISO, keep nulls. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Maps a raw `memberships` row onto the rule input shape. */
export function mapMembershipRow(row: Record<string, unknown>): MembershipRecord {
  return {
    id: readString(row.id) ?? '',
    userId: readString(row.user_id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    role: readString(row.role) ?? '',
    scopes: readStringArray(row.scopes),
    active: readBoolean(row.active),
    validFrom: toIso(row.valid_from) ?? '',
    validTo: toIso(row.valid_to),
    // Only present when the row carries the `users` join; a membership fixture
    // without it keeps the exact legacy shape.
    ...(row.user_active === undefined ? {} : { userActive: readBoolean(row.user_active) }),
  };
}

/**
 * Loads the caller's membership for one tenant through the request client, so
 * RLS applies. Returns null when there is no row — the guard then denies with
 * `membership.inactive` instead of throwing.
 */
export async function loadMembership(
  client: AuditClient,
  userId: string,
  tenantId: string,
): Promise<MembershipRecord | null> {
  const result = await client.query(SELECT_MEMBERSHIP_SQL, [userId, tenantId]);
  const rows = (result as QueryResultLike | undefined)?.rows;
  if (rows === undefined || rows.length === 0) return null;
  return mapMembershipRow(rows[0]);
}

/**
 * Org node recorded on a denial, or NULL when no real node is known.
 *
 * `audit_log.org_node_id` is a FK to `org_nodes`, and the tenant id lives in
 * `tenants`: recording it here was the MVP1 W2F failure (untyped 500 instead of
 * the typed 403 for every membership-less caller). Callers that have no target
 * node pass the tenant id as a placeholder for the scope term, so the guard
 * refuses to record it.
 */
function auditOrgNodeId(ctx: GuardContext): string | null {
  const candidate = ctx.audit.orgNodeId ?? ctx.entityOrgNodeId;
  if (candidate === undefined || candidate === null || candidate === '') return null;
  return candidate === ctx.identity.tenantId ? null : candidate;
}

/** Writes the `access.denied` row; throws if the trail cannot be written. */
async function writeAccessDenied(
  ctx: GuardContext,
  decision: AccessDecision,
  now: string,
): Promise<void> {
  const diff = {
    traceId: ctx.audit.traceId,
    reason: decision.reason,
    attemptedAction: ctx.audit.attemptedAction ?? 'unknown',
    role: ctx.membership?.role ?? null,
    roles: [...ctx.identity.roles],
    entityOrgNodeId: ctx.entityOrgNodeId,
    at: now,
  };

  await ctx.audit.client.query(INSERT_ACCESS_DENIED_SQL, [
    ctx.membership?.tenantId ?? ctx.identity.tenantId,
    ctx.identity.sub,
    ACCESS_DENIED_ACTION,
    ctx.audit.entity,
    ctx.audit.entityId ?? null,
    auditOrgNodeId(ctx),
    JSON.stringify(diff),
    ctx.audit.ip ?? null,
  ]);
}

/**
 * Evaluates the formal rule and audits every denial.
 *
 * Returns the {@link AccessDecision} so the caller can build the
 * `{code, message, traceId}` 403 envelope without re-deciding. On `allow`
 * nothing is written.
 */
export async function canActivate(ctx: GuardContext): Promise<AccessDecision> {
  const now = ctx.now ?? new Date().toISOString();
  const membership = ctx.membership;

  const request: AccessRequest = {
    // Prefer an explicit caller override, then the JOIN-resolved `users.active`,
    // and only then the documented default for hand-built contexts.
    userActive: ctx.userActive ?? membership?.userActive ?? true,
    membershipActive: membership?.active ?? false,
    now,
    validFrom: membership?.validFrom ?? now,
    validTo: membership?.validTo ?? null,
    entityOrgNodeId: ctx.entityOrgNodeId,
    scopeSubtree: [...ctx.scopeSubtree],
    rolePermits: ctx.rolePermits,
    stateAllows: ctx.stateAllows,
    moduleActive: ctx.moduleActive,
  };

  const decision = decideAccess(request);
  if (decision.allow) return decision;

  await writeAccessDenied(ctx, decision, now);
  return decision;
}
