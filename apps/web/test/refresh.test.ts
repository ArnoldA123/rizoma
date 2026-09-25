// Token refresh tests — refresh cookie codec, `grant_type=refresh_token`
// exchange, lazy renewal with singleflight, and the logout contract.
//
// Why two cookies: the slim session (~2KB) plus refresh and ID tokens used to
// travel together (~2.9KB) and browsers never persisted the `Set-Cookie`
// after the callback redirect. The split keeps each cookie well under the
// ~4KB practical limit; the size test below pins that.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_COOKIE } from '../lib/config.ts';
import { OidcError, refreshAccessTokens } from '../lib/oidc.ts';
import {
  REFRESH_COOKIE,
  decodeRefresh,
  encodeRefresh,
  ensureFreshAccessToken,
  inflightRefreshCount,
  singleflightRefresh,
} from '../lib/refresh.ts';
import { decodeSession, encodeSession } from '../lib/session-codec.ts';

const NOW = Date.parse('2026-09-25T13:00:00.000Z');
const EXPIRED_AT = NOW - 60_000;
const FRESH_AT = NOW + 3_600_000;

function jarOf(entries: Record<string, string>) {
  return { get: (name: string): string | undefined => entries[name] };
}

function sessionValue(expiresAt: number): string {
  return encodeSession({ accessToken: 'old-access', expiresAt, tokenType: 'Bearer' });
}

function refreshValue(refreshToken: string): string {
  return encodeRefresh({ refreshToken, idToken: 'old-id' });
}

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function realmSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'new-access',
    refresh_token: 'refresh-next',
    id_token: 'new-id',
    expires_in: 300,
    token_type: 'Bearer',
    ...overrides,
  };
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: unknown, init: unknown) =>
    handler(String(url), init as RequestInit)) as unknown as typeof fetch;
}

test('el codec del refresh persiste refresh e id y rechaza lo parcial', () => {
  const decoded = decodeRefresh(encodeRefresh({ refreshToken: 'r', idToken: 'i' }));
  assert.deepEqual(decoded, { refreshToken: 'r', idToken: 'i' });
  assert.deepEqual(decodeRefresh(encodeRefresh({ refreshToken: 'r', idToken: null })), {
    refreshToken: 'r',
    idToken: null,
  });
  assert.equal(decodeRefresh(undefined), null);
  assert.equal(decodeRefresh(null), null);
  assert.equal(decodeRefresh(''), null);
  assert.equal(decodeRefresh('no-es-base64!!!'), null);
  assert.equal(
    decodeRefresh(Buffer.from(JSON.stringify({ idToken: 'i' })).toString('base64url')),
    null,
  );
});

test('refreshAccessTokens pide grant_type=refresh_token sin secreto', async () => {
  let seenUrl = '';
  let seenBody = '';
  const fetchImpl = stubFetch(async (url, init) => {
    seenUrl = url;
    seenBody = String(init.body);
    return tokenResponse(realmSet());
  });

  const set = await refreshAccessTokens(
    {
      tokenEndpoint: 'https://realm.test/realms/rizoma/protocol/openid-connect/token',
      clientId: 'rizoma-web',
      refreshToken: 'refresh-viejo',
    },
    fetchImpl,
  );

  assert.match(seenUrl, /protocol\/openid-connect\/token$/);
  const form = new URLSearchParams(seenBody);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), 'rizoma-web');
  assert.equal(form.get('refresh_token'), 'refresh-viejo');
  assert.equal(form.has('client_secret'), false);
  assert.equal(set.accessToken, 'new-access');
  assert.equal(set.refreshToken, 'refresh-next');
  assert.equal(set.idToken, 'new-id');
  assert.equal(set.expiresIn, 300);
});

test('refreshAccessTokens mapea invalid_grant y caídas de red', async () => {
  const rejected = stubFetch(async () =>
    tokenResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
  );
  await assert.rejects(
    () =>
      refreshAccessTokens(
        { tokenEndpoint: 'https://realm.test/token', clientId: 'c', refreshToken: 'r' },
        rejected,
      ),
    (error: unknown) => {
      assert.ok(error instanceof OidcError);
      assert.equal(error.code, 'oidc.invalid_grant');
      assert.equal(error.status, 401);
      return true;
    },
  );

  const down = stubFetch(async () => {
    throw new Error('connection refused');
  });
  await assert.rejects(
    () =>
      refreshAccessTokens(
        { tokenEndpoint: 'https://realm.test/token', clientId: 'c', refreshToken: 'r' },
        down,
      ),
    (error: unknown) => {
      assert.ok(error instanceof OidcError);
      assert.equal(error.code, 'oidc.unreachable');
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test('access vigente: no toca el realm', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('no debió llamarse al realm');
  });
  const result = await ensureFreshAccessToken(
    jarOf({ [SESSION_COOKIE]: sessionValue(FRESH_AT), [REFRESH_COOKIE]: refreshValue('r') }),
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(result.status, 'fresh');
  assert.equal(result.status === 'fresh' && result.accessToken, 'old-access');
});

test('access vencido: renueva, re-persiste y rota el refresh', async () => {
  const fetchImpl = stubFetch(async () => tokenResponse(realmSet({ expires_in: 300 })));
  const result = await ensureFreshAccessToken(
    jarOf({ [SESSION_COOKIE]: sessionValue(EXPIRED_AT), [REFRESH_COOKIE]: refreshValue('r-viejo') }),
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(result.status, 'refreshed');
  assert.equal(result.status === 'refreshed' && result.accessToken, 'new-access');
  if (result.status !== 'refreshed') return;

  const session = decodeSession(result.sessionCookieValue);
  assert.equal(session?.accessToken, 'new-access');
  assert.equal(session?.expiresAt, NOW + 300_000);

  assert.notEqual(result.refreshCookieValue, null);
  const rotated = decodeRefresh(result.refreshCookieValue);
  assert.deepEqual(rotated, { refreshToken: 'refresh-next', idToken: 'new-id' });
  assert.equal(inflightRefreshCount(), 0);
});

test('sin rotación del refresh: conserva la cookie existente', async () => {
  const fetchImpl = stubFetch(async () => tokenResponse(realmSet({ refresh_token: 'r-mismo' })));
  const result = await ensureFreshAccessToken(
    jarOf({ [SESSION_COOKIE]: sessionValue(EXPIRED_AT), [REFRESH_COOKIE]: refreshValue('r-mismo') }),
    { nowMs: NOW, fetchImpl },
  );
  assert.equal(result.status, 'refreshed');
  if (result.status !== 'refreshed') return;
  assert.equal(result.refreshCookieValue, null);
});

test('refresh rechazado: unauthorized con limpieza (logout a /login)', async () => {
  const fetchImpl = stubFetch(async () =>
    tokenResponse({ error: 'invalid_grant', error_description: 'Token expired' }, 400),
  );
  const result = await ensureFreshAccessToken(
    jarOf({ [SESSION_COOKIE]: sessionValue(EXPIRED_AT), [REFRESH_COOKIE]: refreshValue('r-muerto') }),
    { nowMs: NOW, fetchImpl },
  );
  assert.deepEqual(result, {
    status: 'unauthorized',
    reason: 'refresh-failed',
    clearCookies: true,
  });
  assert.equal(inflightRefreshCount(), 0);
});

test('realm inalcanzable: transitorio, sin limpieza', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('connection refused');
  });
  const result = await ensureFreshAccessToken(
    jarOf({ [SESSION_COOKIE]: sessionValue(EXPIRED_AT), [REFRESH_COOKIE]: refreshValue('r-vivo') }),
    { nowMs: NOW, fetchImpl },
  );
  assert.deepEqual(result, {
    status: 'unauthorized',
    reason: 'refresh-unreachable',
    clearCookies: false,
  });
});

test('sin sesión: anónimo sin realm ni limpieza', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('no debió llamarse al realm');
  });
  const result = await ensureFreshAccessToken(jarOf({}), { nowMs: NOW, fetchImpl });
  assert.deepEqual(result, { status: 'unauthorized', reason: 'no-session', clearCookies: false });
});

test('sesión vencida sin refresh: limpieza (nunca se renueva sola)', async () => {
  const fetchImpl = stubFetch(async () => {
    throw new Error('no debió llamarse al realm');
  });
  const result = await ensureFreshAccessToken(
    jarOf({ [SESSION_COOKIE]: sessionValue(EXPIRED_AT) }),
    { nowMs: NOW, fetchImpl },
  );
  assert.deepEqual(result, {
    status: 'unauthorized',
    reason: 'refresh-missing',
    clearCookies: true,
  });
});

test('singleflight: concurrentes comparten un solo canje', async () => {
  let calls = 0;
  let release!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchImpl = stubFetch(async () => {
    calls += 1;
    return gate;
  });
  const jar = jarOf({
    [SESSION_COOKIE]: sessionValue(EXPIRED_AT),
    [REFRESH_COOKIE]: refreshValue('r-compartido'),
  });

  const first = ensureFreshAccessToken(jar, { nowMs: NOW, fetchImpl });
  const second = ensureFreshAccessToken(jar, { nowMs: NOW, fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.equal(inflightRefreshCount(), 1);

  release(tokenResponse(realmSet({ refresh_token: 'r-compartido' })));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'refreshed');
  assert.equal(b.status, 'refreshed');
  assert.equal(calls, 1);
  assert.equal(inflightRefreshCount(), 0);
});

test('singleflight directo comparte la promesa en vuelo', async () => {
  let calls = 0;
  let release!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchImpl = stubFetch(async () => {
    calls += 1;
    return gate;
  });
  const first = singleflightRefresh('r-directo', fetchImpl);
  const second = singleflightRefresh('r-directo', fetchImpl);
  release(tokenResponse(realmSet({ refresh_token: 'r-directo' })));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.accessToken, 'new-access');
  assert.equal(b.accessToken, 'new-access');
  assert.equal(calls, 1);
  assert.equal(inflightRefreshCount(), 0);
});

test('cada cookie queda lejos del límite práctico de 4KB', () => {
  const big = (prefix: string) => `${prefix}.${'x'.repeat(900)}.${'y'.repeat(400)}`;
  const session = encodeSession({
    accessToken: big('access'),
    expiresAt: NOW,
    tokenType: 'Bearer',
  });
  const refresh = encodeRefresh({ refreshToken: big('refresh'), idToken: big('id') });
  assert.ok(session.length < 2000, `sesión mide ${session.length}, se esperaba < 2000`);
  assert.ok(refresh.length < 4096, `refresh mide ${refresh.length}, se esperaba < 4096`);
});
