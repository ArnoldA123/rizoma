// API key contract tests — synthetic payloads only, no live API involved.
//
// They protect the W1 security property at the contract layer: the secret is
// returned exactly once (create response) and every other shape rejects it.
// Runner: `node --test src/api-keys.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  API_KEY_HEADER,
  API_KEY_SECRET_PREFIX,
  apiKeyCreateInputSchema,
  apiKeyCreateResponseSchema,
  apiKeyListSchema,
  apiKeyRecordSchema,
} from './api-keys.ts';

/** Synthetic tenant/key identifiers — demo data, never production values. */
const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';

function recordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: KEY,
    tenantId: TENANT,
    name: 'CI / facturacion',
    keyPrefix: 'a1b2c3d4',
    scopes: ['billing.read'],
    active: true,
    validFrom: '2026-09-25T10:00:00.000Z',
    validTo: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

test('create body accepts a name with default scopes and no expiry', () => {
  const parsed = apiKeyCreateInputSchema.parse({ name: 'ETL nocturno' });
  assert.equal(parsed.name, 'ETL nocturno');
  assert.deepEqual(parsed.scopes, []);
});

test('create body accepts scopes and an explicit expiry', () => {
  const parsed = apiKeyCreateInputSchema.parse({
    name: 'CI',
    scopes: ['billing.read', 'files.write'],
    validTo: '2027-01-01T00:00:00.000Z',
  });
  assert.deepEqual(parsed.scopes, ['billing.read', 'files.write']);
  assert.equal(parsed.validTo, '2027-01-01T00:00:00.000Z');
});

test('create body rejects a blank name and a blank scope', () => {
  assert.equal(apiKeyCreateInputSchema.safeParse({ name: '' }).success, false);
  assert.equal(apiKeyCreateInputSchema.safeParse({}).success, false);
  assert.equal(
    apiKeyCreateInputSchema.safeParse({ name: 'CI', scopes: [''] }).success,
    false,
  );
  assert.equal(
    apiKeyCreateInputSchema.safeParse({ name: 'x'.repeat(121) }).success,
    false,
  );
});

test('record accepts the list row shape and rejects a non-UUID id', () => {
  const parsed = apiKeyRecordSchema.parse(recordRow());
  assert.equal(parsed.keyPrefix, 'a1b2c3d4');
  assert.equal(parsed.active, true);
  assert.equal(apiKeyRecordSchema.safeParse(recordRow({ id: 'not-a-uuid' })).success, false);
});

test('record never carries the secret: strict shape rejects it', () => {
  assert.equal(
    apiKeyRecordSchema.strict().safeParse({ ...recordRow(), secret: 'rizoma_leak' }).success,
    false,
  );
});

test('create response carries the secret exactly once', () => {
  const parsed = apiKeyCreateResponseSchema.parse({
    ...recordRow(),
    secret: `${API_KEY_SECRET_PREFIX}opaque-secret`,
  });
  assert.ok(parsed.secret.startsWith(API_KEY_SECRET_PREFIX));
  assert.equal(
    apiKeyCreateResponseSchema.safeParse(recordRow()).success,
    false,
    'secret is required on create',
  );
});

test('list accepts the array the API returns', () => {
  const parsed = apiKeyListSchema.parse([recordRow(), recordRow({ id: TENANT, active: false })]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]?.active, false);
  assert.equal(apiKeyListSchema.safeParse({ rows: [] }).success, false);
});

test('header name is the documented X-Api-Key wire name', () => {
  assert.equal(API_KEY_HEADER, 'x-api-key');
});
