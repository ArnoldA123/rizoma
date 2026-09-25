// Identity derivation tests — claim order, UUID gates and fail-closed behaviour.
//
// The tenant term is the one that decides which data a request can ever touch,
// so it is tested for the failure modes and not only for the happy path: a
// malformed tenant claim, a missing subject, and the case where a token is
// presented but broken while perfectly valid development headers sit next to it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAIM_TENANT,
  deriveIdentity,
  isTokenExpired,
  primaryRole,
  readRoles,
  readScopes,
  readTenantClaim,
  splitScopes,
  tokenExpiresAt,
} from '../lib/tenant.ts';

const TENANT_V4 = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** Builds an unsigned compact token with the given payload. */
function tokenWith(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'demo-key' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

test('deriveIdentity toma el claim tenant_id cuando está presente', () => {
  const result = deriveIdentity({
    token: tokenWith({
      sub: USER,
      [CLAIM_TENANT]: TENANT_V4,
      azp: 'otro-cliente',
      realm_access: { roles: ['medico', 'enfermeria'] },
      scope: 'openid perfil escrito',
    }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.tenantId, TENANT_V4);
  assert.equal(result.identity.userId, USER);
  assert.deepEqual(result.identity.roles, ['medico', 'enfermeria']);
  assert.deepEqual(result.identity.scopes, ['openid', 'perfil', 'escrito']);
  assert.equal(result.identity.source, 'token');
});

test('deriveIdentity cae a azp cuando falta tenant_id', () => {
  const result = deriveIdentity({
    token: tokenWith({ sub: USER, azp: TENANT_V4 }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.tenantId, TENANT_V4);
});

test('deriveIdentity rechaza un tenant que no es UUID v4', () => {
  const result = deriveIdentity({
    token: tokenWith({ sub: USER, [CLAIM_TENANT]: 'tenant-sin-formato' }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'tenant.missing');
  assert.equal(result.reason, 'tenant.missing');
});

test('deriveIdentity rechaza un token sin sub válido', () => {
  const result = deriveIdentity({
    token: tokenWith({ sub: 'no-es-uuid', [CLAIM_TENANT]: TENANT_V4 }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'tenant.user_invalid');
});

test('deriveIdentity falla cerrado: token roto no cae a las cabeceras locales', () => {
  const result = deriveIdentity({
    token: 'no-es-un-token',
    devHeaders: { tenantId: TENANT_V4, userId: USER, scopes: 'openid' },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'auth.token_invalid');
  assert.equal(result.reason, 'token.malformed');
});

test('deriveIdentity usa las cabeceras locales solo sin sesión', () => {
  const ok = deriveIdentity({
    token: null,
    devHeaders: { tenantId: TENANT_V4, userId: USER, scopes: 'openid, site.read' },
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.identity.source, 'dev-headers');
  assert.deepEqual(ok.identity.scopes, ['openid', 'site.read']);
  assert.deepEqual(ok.identity.roles, []);

  // `NEXT_PUBLIC_DEV_ROLE` alimenta el espejo de la guarda: sin él la sesión
  // local no puede saber su rol y ninguna pantalla sería alcanzable.
  const withRole = deriveIdentity({
    token: null,
    devHeaders: { tenantId: TENANT_V4, userId: USER, role: 'trabajador' },
  });
  assert.equal(withRole.ok, true);
  if (!withRole.ok) return;
  assert.deepEqual(withRole.identity.roles, ['trabajador']);
  assert.equal(primaryRole(withRole.identity), 'trabajador');

  const missingTenant = deriveIdentity({ token: null, devHeaders: { userId: USER } });
  assert.equal(missingTenant.ok, false);
  if (missingTenant.ok) return;
  assert.equal(missingTenant.code, 'tenant.missing');

  const badUser = deriveIdentity({
    token: null,
    devHeaders: { tenantId: TENANT_V4, userId: 'usuario-1' },
  });
  assert.equal(badUser.ok, false);
  if (badUser.ok) return;
  assert.equal(badUser.code, 'tenant.user_invalid');

  const nothing = deriveIdentity({});
  assert.equal(nothing.ok, false);
  if (nothing.ok) return;
  assert.equal(nothing.code, 'tenant.missing');
});

test('lectura de claims: roles planos y scp como respaldo', () => {
  assert.deepEqual(readRoles({ realm_access: { roles: ['gerente'] } }), ['gerente']);
  assert.deepEqual(readRoles({ roles: ['capataz', 'capataz'] }), ['capataz']);
  assert.deepEqual(readRoles({}), []);
  assert.deepEqual(readScopes({ scope: 'a b' }), ['a', 'b']);
  assert.deepEqual(readScopes({ scp: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(splitScopes('a,,b  c'), ['a', 'b', 'c']);
  assert.deepEqual(splitScopes(undefined), []);
});

test('readTenantClaim respeta el orden tenant_id → azp', () => {
  assert.equal(readTenantClaim({ [CLAIM_TENANT]: 'a', azp: 'b' }), 'a');
  assert.equal(readTenantClaim({ azp: 'b' }), 'b');
  assert.equal(readTenantClaim({}), undefined);
  assert.equal(readTenantClaim({ [CLAIM_TENANT]: '   ' }), undefined);
});

test('expiración del token: exp ausente cuenta como expirado', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  const valid = tokenWith({ exp: Math.floor(now / 1000) + 600 });
  const expired = tokenWith({ exp: Math.floor(now / 1000) - 1 });
  const noExp = tokenWith({ sub: USER });

  assert.equal(tokenExpiresAt(valid), Math.floor(now / 1000) + 600);
  assert.equal(isTokenExpired(valid, now), false);
  assert.equal(isTokenExpired(expired, now), true);
  assert.equal(isTokenExpired(noExp, now), true);
  assert.equal(isTokenExpired('basura', now), true);
});

test('primaryRole toma el primer rol declarado del realm', () => {
  const identity = {
    tenantId: TENANT_V4,
    userId: USER,
    roles: ['rol_inventado', 'jefe_obra', 'capataz'],
    scopes: [],
    source: 'token' as const,
  };
  assert.equal(primaryRole(identity), 'jefe_obra');
  assert.equal(primaryRole({ ...identity, roles: [] }), null);
  assert.equal(primaryRole({ ...identity, roles: ['soporte'] }), 'soporte');
});
