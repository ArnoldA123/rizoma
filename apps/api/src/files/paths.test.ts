// Object-key builder for tenant-scoped files (bases-consolidadas-v1.md §4.5:
// path `tenant/{tenant_id}/{module}/{yyyy}/{mm}/{uuid}`, signed URL life ≤5 min,
// permanent public URL forbidden for health). Runs with node:test, no deps.
// All UUIDs here are synthetic demo values; none reference a real entity.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObjectKey,
  parseObjectKey,
  isHealthModule,
  SIGNED_URL_TTL_SECONDS,
  FILE_MODULES,
} from './paths.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OBJECT_V4 = '22222222-2222-4222-8222-222222222222';

describe('buildObjectKey', () => {
  it('builds the exact tenant/{id}/{module}/{yyyy}/{mm}/{uuid} shape', () => {
    const key = buildObjectKey(TENANT, 'salud', '2025-03-09', OBJECT_V4);
    assert.equal(
      key,
      `tenant/${TENANT}/salud/2025/03/${OBJECT_V4}`,
    );
  });

  it('zero-pads months to two digits', () => {
    assert.equal(
      buildObjectKey(TENANT, 'salud', '2025-01-01', OBJECT_V4),
      `tenant/${TENANT}/salud/2025/01/${OBJECT_V4}`,
    );
    assert.equal(
      buildObjectKey(TENANT, 'salud', '2025-12-31', OBJECT_V4),
      `tenant/${TENANT}/salud/2025/12/${OBJECT_V4}`,
    );
  });

  it('accepts every closed-list module', () => {
    for (const module of FILE_MODULES) {
      assert.match(buildObjectKey(TENANT, module, '2025-06-15', OBJECT_V4), /\/2025\/06\//);
    }
  });

  it('rejects a tenant that is not a UUID', () => {
    assert.throws(() => buildObjectKey('tenant-1', 'salud', '2025-03-09', OBJECT_V4));
    assert.throws(() => buildObjectKey('', 'salud', '2025-03-09', OBJECT_V4));
    assert.throws(() => buildObjectKey('not-a-uuid-at-all', 'salud', '2025-03-09', OBJECT_V4));
  });

  it('rejects a module outside the closed list', () => {
    assert.throws(() => buildObjectKey(TENANT, 'contabilidad', '2025-03-09', OBJECT_V4));
    assert.throws(() => buildObjectKey(TENANT, '', '2025-03-09', OBJECT_V4));
  });

  it('rejects an object id that is not UUID v4', () => {
    const v1 = '22222222-2222-1222-8222-222222222222';
    assert.throws(() => buildObjectKey(TENANT, 'salud', '2025-03-09', v1));
    assert.throws(() => buildObjectKey(TENANT, 'salud', '2025-03-09', 'not-a-uuid'));
  });

  it('rejects a malformed dateISO', () => {
    assert.throws(() => buildObjectKey(TENANT, 'salud', '09/03/2025', OBJECT_V4));
    assert.throws(() => buildObjectKey(TENANT, 'salud', '2025-13-01', OBJECT_V4));
    assert.throws(() => buildObjectKey(TENANT, 'salud', '', OBJECT_V4));
  });

  it('is case-insensitive for UUID inputs but normalizes to lower-case', () => {
    const key = buildObjectKey(TENANT.toUpperCase(), 'salud', '2025-03-09', OBJECT_V4.toUpperCase());
    assert.equal(key, `tenant/${TENANT}/salud/2025/03/${OBJECT_V4}`);
  });
});

describe('parseObjectKey', () => {
  it('round-trips a key built from a known tenant, module and date', () => {
    const key = buildObjectKey(TENANT, 'obras', '2025-03-01', OBJECT_V4);
    const parsed = parseObjectKey(key);
    assert.deepEqual(parsed, {
      tenantId: TENANT,
      module: 'obras',
      year: 2025,
      month: 3,
      uuid: OBJECT_V4,
    });
  });

  it('rebuilds the identical key from the parsed parts', () => {
    const key = buildObjectKey(TENANT, 'facturacion', '2024-11-30', OBJECT_V4);
    const parsed = parseObjectKey(key);
    assert.ok(parsed);
    const rebuilt = buildObjectKey(
      parsed.tenantId,
      parsed.module,
      `${parsed.year}-${String(parsed.month).padStart(2, '0')}-01`,
      parsed.uuid,
    );
    assert.equal(rebuilt, key);
  });

  it('returns null for malformed keys', () => {
    assert.equal(parseObjectKey(''), null);
    assert.equal(parseObjectKey('tenant/x/salud/2025/03/y'), null);
    assert.equal(parseObjectKey('bucket/tenant/salud/2025/03/' + OBJECT_V4), null);
    assert.equal(parseObjectKey(`tenant/${TENANT}/contabilidad/2025/03/${OBJECT_V4}`), null);
    assert.equal(parseObjectKey(`tenant/${TENANT}/salud/2025/13/${OBJECT_V4}`), null);
    assert.equal(parseObjectKey(`tenant/${TENANT}/salud/2025/03/not-a-uuid`), null);
  });
});

describe('signing policy', () => {
  it('keeps the signed URL TTL at or below 5 minutes', () => {
    assert.ok(SIGNED_URL_TTL_SECONDS <= 300, `TTL was ${SIGNED_URL_TTL_SECONDS}s`);
    assert.equal(SIGNED_URL_TTL_SECONDS, 300);
  });
});

describe('isHealthModule', () => {
  it('marks the health module and only the health module', () => {
    assert.equal(isHealthModule('salud'), true);
    assert.equal(isHealthModule('obras'), false);
    assert.equal(isHealthModule('crm-core'), false);
    assert.equal(isHealthModule(''), false);
  });
});
