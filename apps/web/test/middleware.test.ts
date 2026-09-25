// Middleware gate tests — an expired access token with a valid refresh grant
// lets the request through for lazy downstream renewal instead of bouncing
// to `/login`.
//
// `middleware.ts` itself imports `next/server` with extensionless paths, so it
// cannot load under plain `node --test`. The gate predicate
// (`hasRenewableSession`) lives in the Edge-safe `session-codec.ts` precisely
// so this contract is unit testable here; the middleware only wires it to the
// redirect.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SESSION_COOKIE } from '../lib/config.ts';
import {
  REFRESH_COOKIE,
  decodeRefresh,
  encodeRefresh,
  encodeSession,
  hasRenewableSession,
} from '../lib/session-codec.ts';
import * as refreshModule from '../lib/refresh.ts';

const NOW = Date.parse('2026-09-25T13:00:00.000Z');
const EXPIRED_AT = NOW - 60_000;
const FRESH_AT = NOW + 3_600_000;

function sessionValue(expiresAt: number): string {
  return encodeSession({ accessToken: 'old-access', expiresAt, tokenType: 'Bearer' });
}

function refreshValue(refreshToken: string): string {
  return encodeRefresh({ refreshToken, idToken: 'old-id' });
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('fresh session never takes the renewable path', () => {
  assert.equal(hasRenewableSession(sessionValue(FRESH_AT), refreshValue('r'), NOW), false);
});

test('expired session with a valid refresh grant may pass', () => {
  assert.equal(hasRenewableSession(sessionValue(EXPIRED_AT), refreshValue('r'), NOW), true);
});

test('legacy full-shape expired session with a valid refresh grant may pass', () => {
  const legacy = base64UrlJson({
    accessToken: 'old-access',
    refreshToken: 'legacy-refresh',
    idToken: 'legacy-id',
    expiresAt: EXPIRED_AT,
    tokenType: 'Bearer',
  });
  assert.equal(hasRenewableSession(legacy, refreshValue('r'), NOW), true);
});

test('token inside the 30s safety margin counts as expired', () => {
  const almostExpired = sessionValue(NOW + 10_000);
  assert.equal(hasRenewableSession(almostExpired, refreshValue('r'), NOW), true);
});

test('expired session without a refresh grant stays on the login path', () => {
  const expired = sessionValue(EXPIRED_AT);
  assert.equal(hasRenewableSession(expired, undefined, NOW), false);
  assert.equal(hasRenewableSession(expired, null, NOW), false);
  assert.equal(hasRenewableSession(expired, '', NOW), false);
});

test('expired session with a malformed refresh grant stays on the login path', () => {
  const expired = sessionValue(EXPIRED_AT);
  assert.equal(hasRenewableSession(expired, 'no-es-base64!!!', NOW), false);
  assert.equal(
    hasRenewableSession(expired, base64UrlJson({ idToken: 'i' }), NOW),
    false,
  );
  assert.equal(
    hasRenewableSession(expired, base64UrlJson({ refreshToken: '' }), NOW),
    false,
  );
});

test('missing session never passes, even with a valid refresh grant', () => {
  const refresh = refreshValue('r');
  assert.equal(hasRenewableSession(undefined, refresh, NOW), false);
  assert.equal(hasRenewableSession(null, refresh, NOW), false);
  assert.equal(hasRenewableSession('', refresh, NOW), false);
});

test('malformed session never passes, even with a valid refresh grant', () => {
  assert.equal(hasRenewableSession('no-es-base64!!!', refreshValue('r'), NOW), false);
});

test('session and refresh travel in distinct cookies', () => {
  assert.notEqual(SESSION_COOKIE, REFRESH_COOKIE);
});

test('refresh.ts re-exports the Edge-safe cookie name and codec', () => {
  assert.equal(refreshModule.REFRESH_COOKIE, REFRESH_COOKIE);
  assert.equal(refreshModule.encodeRefresh, encodeRefresh);
  assert.equal(refreshModule.decodeRefresh, decodeRefresh);
  const viaRefresh = refreshModule.encodeRefresh({ refreshToken: 'r', idToken: null });
  assert.deepEqual(decodeRefresh(viaRefresh), { refreshToken: 'r', idToken: null });
});
