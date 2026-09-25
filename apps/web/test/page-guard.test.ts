// Page-guard renewal tests (H6c).
//
// `guardPage` resolves through `currentSession`, which renews lazily when the
// access token is expired but a refresh grant is stored. These tests inject
// the already-resolved session (renewed vs. expired) so the role rule can be
// driven without a Next request context: a renewed `medico` session allows
// `/salud/pacientes`, while a rejected refresh keeps the fail-closed denial
// pages rendered before H6c.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_COOKIE } from '../lib/config.ts';
import { guardPage } from '../lib/page-guard.ts';
import { REFRESH_COOKIE, encodeRefresh } from '../lib/refresh.ts';
import { encodeSession } from '../lib/session-codec.ts';
import { resolveSessionFromJar } from '../lib/session.ts';

const NOW = Date.parse('2026-09-25T13:00:00.000Z');
const EXPIRED_AT = NOW - 60_000;
const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-12d3-a456-426614174001';

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function accessToken(): string {
  return (
    `${base64UrlJson({ alg: 'none' })}.` +
    `${base64UrlJson({
      sub: USER_ID,
      tenant_id: TENANT_ID,
      realm_access: { roles: ['medico'] },
      scope: 'openid profile email',
    })}.sig`
  );
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

test('guard allows the route for a lazily renewed session', async () => {
  const renewed = accessToken();
  const fetchImpl = stubFetch(async () =>
    tokenResponse({
      access_token: renewed,
      refresh_token: 'refresh-next',
      id_token: 'new-id',
      expires_in: 300,
      token_type: 'Bearer',
    }),
  );
  const session = await resolveSessionFromJar(
    {
      get: (name: string): string | undefined =>
        ({
          [SESSION_COOKIE]: encodeSession({
            accessToken: 'old-access',
            expiresAt: EXPIRED_AT,
            tokenType: 'Bearer',
          }),
          [REFRESH_COOKIE]: encodeRefresh({ refreshToken: 'r-live', idToken: 'old-id' }),
        })[name],
    },
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(session.expired, false);

  const guard = await guardPage('/salud/pacientes', { session });
  assert.equal(guard.role, 'medico');
  assert.equal(guard.decision.allow, true);
});

test('guard denies fail-closed when the refresh is rejected', async () => {
  const fetchImpl = stubFetch(async () =>
    tokenResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
  );
  const session = await resolveSessionFromJar(
    {
      get: (name: string): string | undefined =>
        ({
          [SESSION_COOKIE]: encodeSession({
            accessToken: 'old-access',
            expiresAt: EXPIRED_AT,
            tokenType: 'Bearer',
          }),
          [REFRESH_COOKIE]: encodeRefresh({ refreshToken: 'r-dead', idToken: 'old-id' }),
        })[name],
    },
    null,
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(session.expired, true);

  const guard = await guardPage('/salud/pacientes', { session });
  assert.equal(guard.session.identity.ok, false);
  assert.equal(guard.decision.allow, false);
});

test('guard keeps denying unknown routes even for a renewed session', async () => {
  const renewed = accessToken();
  const fetchImpl = stubFetch(async () =>
    tokenResponse({
      access_token: renewed,
      refresh_token: 'r-same',
      id_token: 'new-id',
      expires_in: 300,
      token_type: 'Bearer',
    }),
  );
  const session = await resolveSessionFromJar(
    {
      get: (name: string): string | undefined =>
        ({
          [SESSION_COOKIE]: encodeSession({
            accessToken: 'old-access',
            expiresAt: EXPIRED_AT,
            tokenType: 'Bearer',
          }),
          [REFRESH_COOKIE]: encodeRefresh({ refreshToken: 'r-same', idToken: 'old-id' }),
        })[name],
    },
    null,
    { nowMs: NOW, fetchImpl },
  );
  const guard = await guardPage('/ruta-inexistente', { session });
  assert.equal(guard.decision.allow, false);
});
