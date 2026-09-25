// Edge middleware — passes the route context forward, and gates the session.
//
// Two responsibilities, both cheap:
//   1. Stamp `x-rizoma-path` on the request so the root layout can resolve the
//      active section and its skin from the same route table the guard uses.
//      Server Components have no pathname API, and a header set here avoids the
//      alternative of duplicating the route table per segment.
//   2. Redirect to `/login` when there is no usable session — but only when the
//      local identity fallback is disabled. Authorisation is NOT decided here:
//      a route-level denial has to render the `{code, reason, traceId}` panel
//      with the route and role that produced it, and that is page work done by
//      the guard mirror in `lib/access.ts`.
import { NextResponse, type NextRequest } from 'next/server';
import { PATH_HEADER, SESSION_COOKIE } from './lib/config';
import { DEV_HEADERS_ENABLED } from './lib/server-config';
import {
  REFRESH_COOKIE,
  decodeSession,
  hasRenewableSession,
  sessionIsExpired,
} from './lib/session-codec';

/** Paths reachable without a session. */
const PUBLIC_PATHS: readonly string[] = ['/login'];

function continueWithPath(request: NextRequest, pathname: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATH_HEADER, pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname)) return continueWithPath(request, pathname);

  const sessionRaw = request.cookies.get(SESSION_COOKIE)?.value;
  const tokens = decodeSession(sessionRaw);
  if (tokens !== null && !sessionIsExpired(tokens)) return continueWithPath(request, pathname);

  // Expired access token but a stored refresh grant: let the request through
  // instead of bouncing to `/login`. Renewal happens lazily downstream — the
  // `proxy` and `session` Route Handlers call `ensureFreshAccessToken` and
  // re-persist the new token set on their own responses.
  //
  // Decision (pass-through vs. renewing here): the Edge runtime is the wrong
  // place for the realm round-trip. It would put token-endpoint config and a
  // network call with its own failure modes on the hot path of every page
  // navigation, and the renewal helper pulls `node:crypto` via `oidc.ts`,
  // which must stay out of the Edge bundle — hence the refresh codec lives in
  // the Edge-safe `session-codec.ts`. The gate stays fail-closed: a missing
  // or malformed refresh grant still falls through to `/login`, and a realm
  // rejection downstream still clears both cookies, so the next load lands on
  // `/login` anyway.
  if (hasRenewableSession(sessionRaw, request.cookies.get(REFRESH_COOKIE)?.value)) {
    return continueWithPath(request, pathname);
  }

  // Outside production the shell stays reachable with the documented local
  // identity headers, so the UI can be exercised while Keycloak is down. In
  // production `DEV_HEADERS_ENABLED` is false and this branch disappears.
  if (DEV_HEADERS_ENABLED) return continueWithPath(request, pathname);

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except the proxy and auth handlers (`/api/*` owns its own status
  // codes), the Next internals and static files.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg$).*)'],
};
