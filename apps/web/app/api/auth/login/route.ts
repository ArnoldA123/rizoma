// Login entry point: builds the Keycloak authorization URL and starts the
// Authorization Code + PKCE flow.
//
// The PKCE verifier and the `state` travel in a short-lived `HttpOnly` cookie
// instead of the URL, so neither value can be read or replayed from the
// browser history. `?next=` is sanitised against the route table before it is
// stored, which closes the open-redirect hole an unchecked return path opens.
import { NextResponse, type NextRequest } from 'next/server';
import { OIDC_FLOW_COOKIE } from '@/lib/config';
import { sanitizeNextPath } from '@/lib/navigation';
import { buildAuthorizeUrl, createPkcePair, createState } from '@/lib/oidc';
import {
  KEYCLOAK_CLIENT_ID,
  OIDC_FLOW_MAX_AGE_SECONDS,
  OIDC_REDIRECT_URI,
  WEB_ORIGIN,
  keycloakEndpoint,
} from '@/lib/server-config';
import { encodeFlow, sessionCookieOptions } from '@/lib/session-codec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): NextResponse {
  const next = sanitizeNextPath(request.nextUrl.searchParams.get('next'));
  const { verifier, challenge } = createPkcePair();
  const state = createState();

  const authorizeUrl = buildAuthorizeUrl({
    authorizeEndpoint: keycloakEndpoint('auth'),
    clientId: KEYCLOAK_CLIENT_ID,
    redirectUri: OIDC_REDIRECT_URI,
    state,
    codeChallenge: challenge,
  });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(
    OIDC_FLOW_COOKIE,
    encodeFlow({ state, codeVerifier: verifier, next }),
    sessionCookieOptions(WEB_ORIGIN, OIDC_FLOW_MAX_AGE_SECONDS),
  );
  return response;
}
