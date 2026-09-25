// Keycloak token verification contract (bases-consolidadas-v1.md §3.1).
//
// Everything runs offline: the signer key pair is generated in-test and the
// JWKS endpoint is a fake `fetch`, so the suite proves signature checking, the
// expiry path, the typed failures and the 10-minute key-set cache without a
// live realm. Deterministic time comes from `options.nowMs`, never from mocks
// of the global clock.
import assert from 'node:assert/strict';
import {
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';
import {
  AUTH_ERROR_CODES,
  AuthError,
  CLAIM_TENANT,
  JWKS_CACHE_TTL_MS,
  clearJwksCache,
  keycloakIssuer,
  keycloakJwksUrl,
  jwksCacheSize,
  verifyKeycloakJwt,
  type Identity,
} from './jwt.ts';
import { resolveTenantContextFromIdentity } from '../tenant/tenant.middleware.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const USER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ISS = 'http://localhost:8080/realms/rizoma';
const JWKS_URL = `${ISS}/protocol/openid-connect/certs`;

// One 2048-bit RSA pair for the whole file: generation is the slow part.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const KID = 'test-key-1';
const ROTATED_KID = 'test-key-2';

function jwkFor(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

const JWKS = { keys: [jwkFor(publicKey, KID)] };
const ROTATED_JWKS = { keys: [jwkFor(publicKey, KID), jwkFor(otherPublicKey, ROTATED_KID)] };

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Builds a signed compact JWS from a claim set. */
function signToken(
  claims: Record<string, unknown>,
  options: { kid?: string; alg?: string; key?: KeyObject } = {},
): string {
  const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(options.key ?? privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: ISS,
    sub: USER_ID,
    exp: now + 300,
    nbf: now - 5,
    iat: now,
    azp: 'rizoma-web',
    [CLAIM_TENANT]: TENANT_ID,
    scope: 'crm-core salud',
    realm_access: { roles: ['medico', 'caja'] },
    ...overrides,
  };
}

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface FetchDouble {
  readonly impl: typeof fetch;
  calls(): number;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status < 400, status, json: async () => body };
}

/** Fake fetch serving a fixed key set and counting invocations. */
function jwksFetch(keys: unknown = JWKS.keys, options: { status?: number } = {}): FetchDouble {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return jsonResponse({ keys }, options.status ?? 200);
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

/** Fake fetch answering with the given responses in order (last one repeats). */
function sequenceFetch(responses: FakeResponse[]): FetchDouble {
  let calls = 0;
  return {
    impl: (async () => {
      const index = Math.min(calls, responses.length - 1);
      calls += 1;
      return responses[index];
    }) as unknown as typeof fetch,
    calls: () => calls,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AuthError, `expected an AuthError, got ${String(error)}`);
    assert.equal((error as AuthError).code, code);
    return error as AuthError;
  }
  throw new Error(`expected the call to reject with ${code}`);
}

beforeEach(() => {
  clearJwksCache();
});

describe('keycloakJwksUrl / keycloakIssuer', () => {
  it('builds the realm JWKS URL from the base URL', () => {
    assert.equal(keycloakJwksUrl('http://localhost:8080', 'rizoma'), JWKS_URL);
  });
  it('builds the issuer and tolerates a trailing slash', () => {
    assert.equal(keycloakIssuer('http://localhost:8080/', 'rizoma'), ISS);
  });
});

describe('verifyKeycloakJwt', () => {
  it('returns the identity of a valid token', async () => {
    const fetchDouble = jwksFetch();
    const identity = await verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
    });

    assert.deepEqual(identity, {
      sub: USER_ID,
      tenantId: TENANT_ID,
      roles: ['medico', 'caja'],
      scope: ['crm-core', 'salud'],
    });
  });

  it('falls back to azp when the tenant claim is absent', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims({ [CLAIM_TENANT]: undefined, azp: TENANT_ID }));
    const identity = await verifyKeycloakJwt(token, JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
    });
    assert.equal(identity.tenantId, TENANT_ID);
  });

  it('honours a custom tenant claim from the configuration', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims({ [CLAIM_TENANT]: undefined, org_tenant: TENANT_ID }));
    const identity = await verifyKeycloakJwt(token, JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
      tenantClaim: 'org_tenant',
    });
    assert.equal(identity.tenantId, TENANT_ID);
  });

  it('rejects an expired token with auth.token_expired', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims({ exp: nowSeconds() - 10 }));
    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenExpired,
    );
  });

  it('rejects a token without a numeric exp claim', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims({ exp: undefined }));
    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
  });

  it('rejects a token whose nbf is in the future', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims({ nbf: nowSeconds() + 120 }));
    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
  });

  it('rejects a token signed by another key', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims(), { key: otherPrivateKey });
    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
  });

  it('rejects a tampered payload', async () => {
    const fetchDouble = jwksFetch();
    const [header, , signature] = signToken(claims()).split('.');
    const tampered = b64url(JSON.stringify(claims({ sub: USER_ID.replace('a', 'b') })));
    await expectCode(
      verifyKeycloakJwt(`${header}.${tampered}.${signature}`, JWKS_URL, ISS, {
        fetchImpl: fetchDouble.impl,
      }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
  });

  it('rejects a token using a non-RS256 algorithm (none)', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims(), { alg: 'none' });
    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
    assert.equal(fetchDouble.calls(), 0, 'an untrusted algorithm never reaches the JWKS');
  });

  it('rejects a malformed token with fewer than three segments', async () => {
    const fetchDouble = jwksFetch();
    await expectCode(
      verifyKeycloakJwt('not-a-jwt', JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
  });

  it('rejects a token from another issuer', async () => {
    const fetchDouble = jwksFetch();
    const token = signToken(claims({ iss: 'http://localhost:8080/realms/other' }));
    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
  });

  it('refreshes once and rejects an unknown kid', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return jsonResponse(JWKS);
    }) as unknown as typeof fetch;
    const token = signToken(claims(), { kid: 'missing-key' });

    await expectCode(
      verifyKeycloakJwt(token, JWKS_URL, ISS, { fetchImpl: impl }),
      AUTH_ERROR_CODES.tokenInvalid,
    );
    assert.equal(calls, 2, 'the cache is bypassed exactly once for rotation');
  });

  it('recovers a rotated signing key within the same request', async () => {
    const fetchDouble = sequenceFetch([
      jsonResponse(JWKS),
      jsonResponse(ROTATED_JWKS),
    ]);
    const token = signToken(claims(), { kid: ROTATED_KID, key: otherPrivateKey });
    const identity = await verifyKeycloakJwt(token, JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
    });

    assert.equal(identity.sub, USER_ID);
    assert.equal(fetchDouble.calls(), 2);
  });
});

describe('JWKS availability', () => {
  it('reports auth.jwks_unavailable when the endpoint is unreachable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expectCode(
      verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, { fetchImpl: impl }),
      AUTH_ERROR_CODES.jwksUnavailable,
    );
  });

  it('reports auth.jwks_unavailable on a non-2xx answer', async () => {
    const fetchDouble = jwksFetch(JWKS.keys, { status: 503 });
    await expectCode(
      verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, { fetchImpl: fetchDouble.impl }),
      AUTH_ERROR_CODES.jwksUnavailable,
    );
  });

  it('reports auth.jwks_unavailable when the body is not JSON', async () => {
    const impl = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    })) as unknown as typeof fetch;
    await expectCode(
      verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, { fetchImpl: impl }),
      AUTH_ERROR_CODES.jwksUnavailable,
    );
  });

  it('reports auth.jwks_unavailable when the document has no keys array', async () => {
    const impl = (async () => jsonResponse({ nope: true })) as unknown as typeof fetch;
    await expectCode(
      verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, { fetchImpl: impl }),
      AUTH_ERROR_CODES.jwksUnavailable,
    );
  });
});

describe('JWKS cache', () => {
  it('serves the second verification from memory without another fetch', async () => {
    const fetchDouble = jwksFetch();
    const options = { fetchImpl: fetchDouble.impl };

    await verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, options);
    await verifyKeycloakJwt(signToken(claims()), JWKS_URL, ISS, options);

    assert.equal(fetchDouble.calls(), 1);
    assert.equal(jwksCacheSize(), 1);
  });

  it('refetches once the 10-minute TTL has elapsed', async () => {
    const fetchDouble = jwksFetch();
    const base = Date.now();
    // Far enough in the future that the simulated clock jump cannot expire it.
    const longLived = signToken(claims({ exp: nowSeconds() + 3_600 }));

    await verifyKeycloakJwt(longLived, JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
      nowMs: base,
    });
    await verifyKeycloakJwt(longLived, JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
      nowMs: base + JWKS_CACHE_TTL_MS - 1,
    });
    assert.equal(fetchDouble.calls(), 1, 'inside the TTL the cache is reused');

    await verifyKeycloakJwt(longLived, JWKS_URL, ISS, {
      fetchImpl: fetchDouble.impl,
      nowMs: base + JWKS_CACHE_TTL_MS,
    });
    assert.equal(fetchDouble.calls(), 2, 'at the TTL boundary the set is refetched');
  });
});

// A3 token -> tenant bridge. It is asserted here because A3's allowed edit
// surface covers `tenant.middleware.ts` but not its existing test file; the
// resolver is pure and belongs with the identity contract this file exercises.
describe('resolveTenantContextFromIdentity', () => {
  const identity = (patch: Partial<Identity> = {}): Identity => ({
    sub: USER_ID,
    tenantId: TENANT_ID,
    roles: ['medico'],
    scope: ['crm-core', 'salud'],
    ...patch,
  });

  it('derives the internal tenant context from a verified identity', () => {
    const result = resolveTenantContextFromIdentity(identity());
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.context, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      scopes: ['crm-core', 'salud'],
    });
  });

  it('rejects a tenant claim that is not a UUID -> tenant.missing', () => {
    const result = resolveTenantContextFromIdentity(identity({ tenantId: 'acme' }));
    assert.equal(result.ok === false && result.error.code, 'tenant.missing');
    assert.equal(result.ok === false && result.status, 403);
  });

  it('rejects a tenant UUID that is not v4 -> tenant.missing', () => {
    const result = resolveTenantContextFromIdentity(
      identity({ tenantId: '3f1c9b2e-4d1a-1e6f-8b2c-5a7d9e0f1a2b' }),
    );
    assert.equal(result.ok === false && result.error.code, 'tenant.missing');
  });

  it('rejects a subject that is not a UUID -> tenant.user_invalid', () => {
    const result = resolveTenantContextFromIdentity(
      identity({ sub: 'service-account-rizoma-api' }),
    );
    assert.equal(result.ok === false && result.error.code, 'tenant.user_invalid');
  });
});
