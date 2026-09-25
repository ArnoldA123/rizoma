// Server-side page guard.
//
// One call per page, in one place, so the guard cannot drift between screens:
// it resolves the session, matches the route against the registry, evaluates
// the role rule and hands back both the decision and a correlation id for the
// denial panel. Pages only decide how to render `allow === false`.
//
// The session comes from `currentSession`, which since H6c attempts one lazy
// renewal when the access token is expired but a refresh grant is stored — so
// an `expired-access + refresh presente` navigation renders the page instead
// of `SessionRequiredNotice`, and a rejected refresh still denies fail-closed
// exactly as before. The optional `session` override exists only so tests can
// drive the role rule without a Next request context; production callers keep
// calling `guardPage(path)`.
import { newTraceId, type RouteDecision } from './access.ts';
import { matchRoute, routeAllows, type AppRoute } from './navigation.ts';
import { currentSession, type CurrentSession } from './session.ts';
import { primaryRole } from './tenant.ts';

/** Everything a guarded page needs, resolved in one pass. */
export interface PageGuard {
  /** Route path as declared in the registry. */
  readonly path: string;
  readonly route: AppRoute | null;
  readonly session: CurrentSession;
  /** Role driving the UI, or `null` when the token carries none. */
  readonly role: string | null;
  readonly decision: RouteDecision;
  /** Correlation id echoed by the denial panel. */
  readonly traceId: string;
}

/** Test-only override: inject an already-resolved session (e.g. a renewal). */
export interface GuardPageOptions {
  readonly session?: CurrentSession;
}

/**
 * Evaluates the route rule for the current request.
 *
 * When the route is unknown, the decision denies with `route.unknown` — a
 * screen missing from the registry is a bug, and failing closed is the only
 * safe default for it.
 */
export async function guardPage(path: string, options?: GuardPageOptions): Promise<PageGuard> {
  const session = options?.session ?? (await currentSession());
  const role = session.identity.ok ? primaryRole(session.identity.identity) : null;
  const decision = routeAllows(role ?? '', path);

  return {
    path,
    route: matchRoute(path)?.route ?? null,
    session,
    role,
    decision,
    traceId: newTraceId(),
  };
}
