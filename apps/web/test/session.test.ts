// Server session lazy-renewal tests (H6c).
//
// The middleware lets `expired-access + refresh presente` through for lazy
// downstream renewal, so the server-side resolution must attempt exactly one
// renewal when the access token is expired and render from the renewed set in
// memory. A rejected, missing or unreachable refresh stays fail-closed with
// the expired identity pages rendered before H6c.
//
// These tests drive `resolveSessionFromJar` — the whole decision tree behind
// `currentSession` — over an explicit cookie jar, so no Next request context
// is needed and the module stays importable under plain `node --test`
// (`next/headers` is only imported dynamically inside the thin wrappers).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_COOKIE } from '../lib/config.ts';
import { REFRESH_COOKIE, encodeRefresh } from '../lib/refresh.ts';
import { encodeSession } from '../lib/session-codec.ts';
import { resolveSessionFromJar } from '../lib/session.ts';

const NOW = Date.parse('2026-09-25T13:00:00.000Z');
const EXPIRED_AT = NOW - 60_000;
const FRESH_AT = NOW + 3_600_000;
const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-12d3-a456-426614174001';

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function accessToken(roles: readonly string[] = ['medico']): string {
  return (
    `${base64UrlJson({ alg: 'none' })}.` +
    `${base64UrlJson({
      sub: USER_ID,
      tenant_id: TENANT_ID,
      realm_access: { roles },
      scope: 'openid profile email',
    })}.sig`
  );
}

function sessionValue(token: string, expiresAt: number): string {
  return encodeSession({ accessToken: token, expiresAt, tokenType: 'Bearer' });
}

function refreshValue(refreshToken: string): string {
  return encodeRefresh({ refreshToken, idToken: 'old-id' });
}

function jarOf(entries: Record<string, string>) {
  return { get: (name: string): string | undefined => entries[name] };
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: unknown, init: unknown) =>
    handler(String(url), init as RequestInit)) as unknown as typeof fetch;
}

test('fresh session resolves without touching the realm', async () => {
  const fresh = accessToken();
  const fetchImpl = stubFetch(async () => {
    throw new Error('realm must not be called for a fresh session');
  });
  const session = await resolveSessionFromJar(
    jarOf({ [SESSION_COOKIE]: sessionValue(fresh, FRESH_AT) }),
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(session.expired, false);
  assert.equal(session.tokens?.accessToken, fresh);
  assert.equal(session.identity.ok, true);
  assert.equal(session.usingDevFallback, false);
});

test('expired session with a valid grant renews in memory (H6c)', async () => {
  const renewed = accessToken();
  let calls = 0;
  const fetchImpl = stubFetch(async () => {
    calls += 1;
    return tokenResponse({
      access_token: renewed,
      refresh_token: 'refresh-next',
      id_token: 'new-id',
      expires_in: 300,
      token_type: 'Bearer',
    });
  });
  const session = await resolveSessionFromJar(
    jarOf({
      [SESSION_COOKIE]: sessionValue('old-access', EXPIRED_AT),
      [REFRESH_COOKIE]: refreshValue('r-live'),
    }),
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(calls, 1);
  assert.equal(session.expired, false);
  assert.equal(session.tokens?.accessToken, renewed);
  assert.equal(session.usingDevFallback, false);
  assert.equal(session.identity.ok, true);
  if (session.identity.ok) {
    assert.equal(session.identity.identity.tenantId, TENANT_ID);
    assert.equal(session.identity.identity.userId, USER_ID);
  }
});

test('rejected refresh stays fail-closed with the expired identity', async () => {
  let calls = 0;
  const fetchImpl = stubFetch(async () => {
    calls += 1;
    return tokenResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400);
  });
  const session = await resolveSessionFromJar(
    jarOf({
      [SESSION_COOKIE]: sessionValue('old-access', EXPIRED_AT),
      [REFRESH_COOKIE]: refreshValue('r-dead'),
    }),
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(calls, 1);
  assert.equal(session.tokens, null);
  assert.equal(session.expired, true);
  assert.equal(session.identity.ok, false);
  assert.equal(session.usingDevFallback, false);
});

test('expired session without a grant never calls the realm', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('realm must not be called without a refresh grant');
  });
  const session = await resolveSessionFromJar(
    jarOf({ [SESSION_COOKIE]: sessionValue('old-access', EXPIRED_AT) }),
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(session.tokens, null);
  assert.equal(session.expired, true);
  assert.equal(session.identity.ok, false);
});

test('missing session never renews, even with a stray refresh grant', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('realm must not mint a session from a stray refresh grant');
  });
  const session = await resolveSessionFromJar(
    jarOf({ [REFRESH_COOKIE]: refreshValue('r-stray') }),
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(session.tokens, null);
  assert.equal(session.expired, false);
  assert.equal(session.identity.ok, false);
});

test('unreachable realm stays fail-closed as expired', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('connection refused');
  });
  const session = await resolveSessionFromJar(
    jarOf({
      [SESSION_COOKIE]: sessionValue('old-access', EXPIRED_AT),
      [REFRESH_COOKIE]: refreshValue('r-live'),
    }),
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(session.tokens, null);
  assert.equal(session.expired, true);
  assert.equal(session.identity.ok, false);
});

test('renewal wins over the dev fallback; failure still falls back', async () => {
  const renewed = accessToken();
  const devHeaders = { tenantId: TENANT_ID, userId: USER_ID, scopes: '', role: 'medico' } as const;
  const okFetch = stubFetch(async () =>
    tokenResponse({
      access_token: renewed,
      refresh_token: 'r-same',
      id_token: 'new-id',
      expires_in: 300,
      token_type: 'Bearer',
    }),
  );
  const renewedSession = await resolveSessionFromJar(
    jarOf({
      [SESSION_COOKIE]: sessionValue('old-access', EXPIRED_AT),
      [REFRESH_COOKIE]: refreshValue('r-same'),
    }),
    devHeaders,
    { nowMs: NOW, fetchImpl: okFetch },
  );
  assert.equal(renewedSession.usingDevFallback, false);
  assert.equal(renewedSession.identity.ok, true);
  if (renewedSession.identity.ok) {
    assert.equal(renewedSession.identity.identity.source, 'token');
  }

  const deadFetch = stubFetch(async () =>
    tokenResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
  );
  const fallbackSession = await resolveSessionFromJar(
    jarOf({
      [SESSION_COOKIE]: sessionValue('old-access', EXPIRED_AT),
      [REFRESH_COOKIE]: refreshValue('r-dead'),
    }),
    devHeaders,
    { nowMs: NOW, fetchImpl: deadFetch },
  );
  assert.equal(fallbackSession.usingDevFallback, true);
  assert.equal(fallbackSession.expired, true);
  assert.equal(fallbackSession.identity.ok, true);
});
