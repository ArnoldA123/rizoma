// Logout: drops the local session first, then asks the realm to end the SSO
// session.
//
// Order matters. If the realm redirect is attempted first and Keycloak is
// unreachable, the local cookie would survive and the user would still be
// logged in — the opposite of what "salir" means. Clearing locally is
// unconditional; the end-session hop is best effort.
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/config';
import { buildLogoutUrl } from '@/lib/oidc';
import {
  KEYCLOAK_CLIENT_ID,
  OIDC_POST_LOGOUT_REDIRECT_URI,
  WEB_ORIGIN,
  keycloakEndpoint,
} from '@/lib/server-config';
import { decodeSession } from '@/lib/session-codec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): NextResponse {
  const tokens = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);

  const target =
    tokens?.idToken === null || tokens?.idToken === undefined
      ? new URL('/login', WEB_ORIGIN).toString()
      : buildLogoutUrl({
          endSessionEndpoint: keycloakEndpoint('logout'),
          clientId: KEYCLOAK_CLIENT_ID,
          postLogoutRedirectUri: OIDC_POST_LOGOUT_REDIRECT_URI,
          idTokenHint: tokens.idToken,
        });

  const response = NextResponse.redirect(target);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
