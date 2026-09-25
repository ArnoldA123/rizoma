// State-transition catalog — generic guard over `state_transitions`
// (migration 009, B3).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) like the domain services that call it.
// The catalog is closed: a transition consults the table, an unlisted
// (entity, from, to) triple is denied, and a listed one additionally requires
// the caller's membership role in `allowed_roles`.
//
// Rollout contract: the three migrated call-sites (episodes, attendance,
// site_log) consult this predicate *alongside* their legacy state comparison
// (`legacy || transition`), so behavior is unchanged while the seed agrees
// with the legacy checks — which it does by construction (the seed mirrors
// the policy matrix). New transitions and new call-sites use this predicate
// as the sole authority.

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface TransitionClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Entities the 009 catalog covers. Anything else is denied (closed). */
export const TRANSITION_ENTITIES = ['episode', 'attendance', 'site_log'] as const;

export type TransitionEntity = (typeof TRANSITION_ENTITIES)[number];

/** Input of {@link assertTransition}: the attempted move and who attempts it. */
export interface AssertTransitionOptions {
  /** Catalog entity: `episode`, `attendance` or `site_log`. */
  readonly entity: string;
  /** Current status of the row. */
  readonly from: string;
  /** Status the write would set. */
  readonly to: string;
  /** Membership role of the caller (empty when there is no membership). */
  readonly role: string;
  /**
   * Tenant scope carried explicitly (§4.2), so isolation holds even where the
   * connection role can bypass RLS. Omit only where the client is already
   * tenant-bound and the caller accepts the RLS-only read.
   */
  readonly tenantId?: string;
}

const SELECT_TRANSITION_SQL =
  'SELECT allowed_roles FROM state_transitions WHERE entity = $1 AND from_status = $2 AND to_status = $3';

const SELECT_TRANSITION_TENANT_SQL =
  'SELECT allowed_roles FROM state_transitions ' +
  'WHERE tenant_id = $1 AND entity = $2 AND from_status = $3 AND to_status = $4';

/**
 * Checks one state transition against the closed catalog.
 *
 * Returns `true` when the triple is listed AND the role is in its
 * `allowed_roles`; `false` otherwise — including an unknown entity, an
 * unlisted triple, a role outside the grant, and a query failure (fail-closed
 * term: a missing table never reads as permission).
 *
 * Never throws: call-sites keep owning their envelopes (403/409 shapes stay
 * exactly as before), this predicate only feeds their `stateAllows` term.
 */
export async function assertTransition(
  client: TransitionClient,
  options: AssertTransitionOptions,
): Promise<boolean> {
  try {
    const result =
      options.tenantId === undefined
        ? await client.query(SELECT_TRANSITION_SQL, [options.entity, options.from, options.to])
        : await client.query(SELECT_TRANSITION_TENANT_SQL, [
            options.tenantId,
            options.entity,
            options.from,
            options.to,
          ]);
    const row = readRows(result)[0];
    if (row === undefined) return false;
    const allowed = row.allowed_roles;
    return Array.isArray(allowed) && allowed.includes(options.role);
  } catch {
    return false;
  }
}
