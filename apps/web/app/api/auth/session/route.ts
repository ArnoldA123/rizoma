// Session introspection for client components.
//
// Returns the *derived* identity only — tenant, user, roles and scopes — never
// the access token. Client components need the role to filter affordances,
// and this is the smallest answer that lets them do it without putting the
// credential in the browser.
//
// The handler renews lazily: when the access token is expired but a refresh
// token is stored, it calls the realm once (`grant_type=refresh_token`) and
// re-persists the new token set on the response. A rejected refresh ends the
// session (both cookies cleared, 401 `auth.session_expired`) so the client
// can send the user back to `/login`.
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/config';
import { REFRESH_COOKIE, ensureFreshAccessToken } from '@/lib/refresh';
import { WEB_ORIGIN } from '@/lib/server-config';
import { currentSession } from '@/lib/session';
import { sessionCookieOptions } from '@/lib/session-codec';
import { deriveIdentity } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function expiredSessionResponse(): NextResponse {
  const response = NextResponse.json(
    {
      code: 'auth.session_expired',
      message: 'La sesión venció y no pudo renovarse; vuelva a iniciar sesión.',
      traceId: `web-${crypto.randomUUID()}`,
    },
    { status: 401 },
  );
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ensured = await ensureFreshAccessToken({
    get: (name) => request.cookies.get(name)?.value,
  });

  if (ensured.status === 'unauthorized' && ensured.clearCookies) {
    if (ensured.reason === 'refresh-unreachable') {
      return NextResponse.json(
        {
          code: 'auth.refresh_unreachable',
          message: 'El realm no está disponible para renovar la sesión.',
          traceId: `web-${crypto.randomUUID()}`,
        },
        { status: 502 },
      );
    }
    return expiredSessionResponse();
  }

  if (ensured.status === 'refreshed') {
    const identity = deriveIdentity({ token: ensured.accessToken });
    if (!identity.ok) {
      return NextResponse.json(
        {
          code: identity.code,
          message: identity.message,
          reason: identity.reason,
          traceId: `web-${crypto.randomUUID()}`,
        },
        { status: 401 },
      );
    }
    const resolved = identity.identity;
    const response = NextResponse.json(
      {
        authenticated: true,
        expired: false,
        source: resolved.source,
        tenantId: resolved.tenantId,
        userId: resolved.userId,
        roles: resolved.roles,
        scopes: resolved.scopes,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
    const options = sessionCookieOptions(WEB_ORIGIN, ensured.maxAgeSeconds);
    response.cookies.set(SESSION_COOKIE, ensured.sessionCookieValue, options);
    if (ensured.refreshCookieValue !== null) {
      response.cookies.set(REFRESH_COOKIE, ensured.refreshCookieValue, options);
    }
    return response;
  }

  const session = await currentSession();

  if (!session.identity.ok) {
    return NextResponse.json(
      {
        code: session.identity.code,
        message: session.identity.message,
        reason: session.identity.reason,
        traceId: `web-${crypto.randomUUID()}`,
      },
      { status: 401 },
    );
  }

  const identity = session.identity.identity;
  return NextResponse.json(
    {
      authenticated: session.tokens !== null,
      expired: session.expired,
      source: identity.source,
      tenantId: identity.tenantId,
      userId: identity.userId,
      roles: identity.roles,
      scopes: identity.scopes,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
