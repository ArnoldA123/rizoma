// OIDC redirect target: validates `state`, exchanges the code for tokens and
// opens the app session.
//
// `state` comparison is the CSRF check of the flow — without it a third party
// could hand the app an authorization code it did not request. The code is
// exchanged server-side with the PKCE verifier, so the realm never needs a
// browser CORS origin and no client secret exists anywhere.
//
// Failure redirects carry a code only. The realm's own message is never echoed
// into the URL: it can contain realm and client details, and the login screen
// has nothing useful to do with them.
import { NextResponse, type NextRequest } from 'next/server';
import { OIDC_FLOW_COOKIE, SESSION_COOKIE } from '@/lib/config';
import { exchangeCodeForTokens, OidcError } from '@/lib/oidc';
import {
  KEYCLOAK_CLIENT_ID,
  OIDC_REDIRECT_URI,
  SESSION_MAX_AGE_SECONDS,
  WEB_ORIGIN,
  keycloakEndpoint,
} from '@/lib/server-config';
import { decodeFlow, encodeSession, sessionCookieOptions } from '@/lib/session-codec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function loginRedirect(errorCode: string): NextResponse {
  const url = new URL('/login', WEB_ORIGIN);
  url.searchParams.set('error', errorCode);
  const response = NextResponse.redirect(url);
  response.cookies.delete(OIDC_FLOW_COOKIE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  const realmError = params.get('error');
  if (realmError !== null) return loginRedirect('oidc.realm_rejected');

  const code = params.get('code');
  const state = params.get('state');
  const flow = decodeFlow(request.cookies.get(OIDC_FLOW_COOKIE)?.value);

  if (flow === null) return loginRedirect('oidc.flow_missing');
  if (code === null || state === null || state !== flow.state) {
    return loginRedirect('oidc.state_mismatch');
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      tokenEndpoint: keycloakEndpoint('token'),
      clientId: KEYCLOAK_CLIENT_ID,
      redirectUri: OIDC_REDIRECT_URI,
      code,
      codeVerifier: flow.codeVerifier,
    });
  } catch (error) {
    const detail = error instanceof OidcError ? error.message : String(error);
    console.error(
      JSON.stringify({ code: 'web.oidc_exchange_failed', message: detail.slice(0, 300) }),
    );
    return loginRedirect('oidc.exchange_failed');
  }

  const response = NextResponse.redirect(new URL(flow.next, WEB_ORIGIN));
  response.cookies.set(
    SESSION_COOKIE,
    encodeSession({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      tokenType: tokens.tokenType,
    }),
    sessionCookieOptions(WEB_ORIGIN, SESSION_MAX_AGE_SECONDS),
  );
  response.cookies.delete(OIDC_FLOW_COOKIE);
  return response;
}
