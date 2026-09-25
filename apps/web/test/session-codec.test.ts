// Session cookie codec tests — slim writes, backward-compatible reads.
//
// The callback redirect used to set a ~2.9KB cookie (access + refresh + ID
// tokens) that browsers never persisted, so `/` kept answering
// `tenant.missing` right after a successful login. The codec now writes the
// slim shape (`accessToken` + `expiresAt` + `tokenType`) and still decodes the
// legacy full shape, so pre-existing cookies keep working until they expire.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeFlow,
  decodeSession,
  encodeFlow,
  encodeSession,
  sessionCookieOptions,
  sessionIsExpired,
} from '../lib/session-codec.ts';

const ACCESS = 'header.payload.signature';
const EXPIRES_AT = Date.parse('2026-09-25T13:00:00.000Z');

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('encodeSession escribe solo la forma adelgazada', () => {
  const raw = encodeSession({ accessToken: ACCESS, expiresAt: EXPIRES_AT, tokenType: 'Bearer' });
  const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(payload).sort(), ['accessToken', 'expiresAt', 'tokenType']);
  assert.equal(payload.accessToken, ACCESS);
  assert.equal(payload.expiresAt, EXPIRES_AT);
  assert.equal(payload.tokenType, 'Bearer');
});

test('encodeSession ignora refresh/id aunque se le pase un juego completo', () => {
  const raw = encodeSession({
    accessToken: ACCESS,
    expiresAt: EXPIRES_AT,
    tokenType: 'Bearer',
    refreshToken: 'refresh-gigante',
    idToken: 'id-gigante',
  } as unknown as Parameters<typeof encodeSession>[0]);
  const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  assert.equal('refreshToken' in payload, false);
  assert.equal('idToken' in payload, false);
  assert.equal('refresh_token' in payload, false);
  assert.equal('id_token' in payload, false);
});

test('la cookie adelgazada es una fracción de la heredada', () => {
  const big = (prefix: string) => `${prefix}.${'x'.repeat(900)}.${'y'.repeat(400)}`;
  const legacy = base64UrlJson({
    accessToken: big('access'),
    refreshToken: big('refresh'),
    idToken: big('id'),
    expiresAt: EXPIRES_AT,
    tokenType: 'Bearer',
  });
  const slim = encodeSession({ accessToken: big('access'), expiresAt: EXPIRES_AT, tokenType: 'Bearer' });
  assert.ok(legacy.length > 2500, `la herencia mide ${legacy.length}, se esperaba > 2500`);
  assert.ok(
    slim.length < legacy.length / 2,
    `adelgazada ${slim.length} vs heredada ${legacy.length}`,
  );
  assert.ok(slim.length < 2000, `adelgazada mide ${slim.length}, se esperaba < 2000`);
});

test('decodeSession lee la forma adelgazada (refresh/id en null)', () => {
  const decoded = decodeSession(
    encodeSession({ accessToken: ACCESS, expiresAt: EXPIRES_AT, tokenType: 'Bearer' }),
  );
  assert.deepEqual(decoded, {
    accessToken: ACCESS,
    refreshToken: null,
    idToken: null,
    expiresAt: EXPIRES_AT,
    tokenType: 'Bearer',
  });
});

test('decodeSession mantiene compat con cookies viejas completas', () => {
  const legacy = base64UrlJson({
    accessToken: ACCESS,
    refreshToken: 'refresh-viejo',
    idToken: 'id-viejo',
    expiresAt: EXPIRES_AT,
    tokenType: 'Bearer',
  });
  assert.deepEqual(decodeSession(legacy), {
    accessToken: ACCESS,
    refreshToken: 'refresh-viejo',
    idToken: 'id-viejo',
    expiresAt: EXPIRES_AT,
    tokenType: 'Bearer',
  });
});

test('decodeSession rechaza valores ausentes, rotos o parciales', () => {
  assert.equal(decodeSession(undefined), null);
  assert.equal(decodeSession(null), null);
  assert.equal(decodeSession(''), null);
  assert.equal(decodeSession('no-es-base64!!!'), null);
  assert.equal(decodeSession(base64UrlJson({ algo: 'distinto' })), null);
  assert.equal(decodeSession(base64UrlJson({ accessToken: ACCESS })), null);
  assert.equal(decodeSession(base64UrlJson({ accessToken: ACCESS, expiresAt: 'pronto' })), null);
});

test('decodeSession usa Bearer cuando falta tokenType', () => {
  const decoded = decodeSession(base64UrlJson({ accessToken: ACCESS, expiresAt: EXPIRES_AT }));
  assert.equal(decoded?.tokenType, 'Bearer');
});

test('sessionIsExpired respeta el margen de 30 segundos', () => {
  const tokens = { accessToken: ACCESS, expiresAt: EXPIRES_AT, tokenType: 'Bearer' } as const;
  assert.equal(sessionIsExpired({ ...tokens }, EXPIRES_AT - 60_000), false);
  assert.equal(sessionIsExpired({ ...tokens }, EXPIRES_AT - 29_000), true);
  assert.equal(sessionIsExpired({ ...tokens }, EXPIRES_AT + 1_000), true);
});

test('sessionCookieOptions: Lax, Path=/ y Secure solo en https', () => {
  const http = sessionCookieOptions('http://localhost:3000', 3600);
  assert.equal(http.httpOnly, true);
  assert.equal(http.sameSite, 'lax');
  assert.equal(http.path, '/');
  assert.equal(http.secure, false);
  assert.equal(http.maxAge, 3600);

  const https = sessionCookieOptions('https://app.rizoma.test', 3600);
  assert.equal(https.secure, true);
  assert.equal(https.sameSite, 'lax');
  assert.equal(https.path, '/');
});

test('el flujo PKCE sigue intacto', () => {
  const raw = encodeFlow({ state: 'estado', codeVerifier: 'verificador', next: '/salud' });
  assert.deepEqual(decodeFlow(raw), { state: 'estado', codeVerifier: 'verificador', next: '/salud' });
  assert.equal(decodeFlow(null), null);
  assert.equal(decodeFlow('basura'), null);
});
