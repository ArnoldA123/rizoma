// Usage-counter coverage (W3): hourly windowing, the 2xx + X-Api-Key gate,
// endpoint normalization and the best-effort single-statement upsert.
//
// The SQL client is a small in-memory double capturing the issued statement,
// so the suite exercises the real writer control flow without Postgres.
// All data is synthetic.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RECORD_USAGE_COUNTER_SQL,
  USAGE_COUNTER_METRIC,
  buildUsageEndpoint,
  recordApiKeyUsage,
  shouldCountUsage,
  truncateToHour,
  type UsageCounterClient,
} from './usage-counters.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const API_KEY_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

interface FakeDb {
  queries: Array<{ text: string; values: readonly unknown[] }>;
  fail: boolean;
}

function createFakeClient(db: FakeDb): UsageCounterClient {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      db.queries.push({ text, values });
      if (db.fail) throw new Error('connection reset');
      return { rows: [] };
    },
  };
}

describe('truncateToHour', () => {
  it('opens the UTC hour window of the served instant', () => {
    assert.equal(truncateToHour('2026-09-25T10:37:12.456Z'), '2026-09-25T10:00:00.000Z');
    assert.equal(truncateToHour(new Date('2026-09-25T23:59:59.999Z')), '2026-09-25T23:00:00.000Z');
    assert.equal(truncateToHour('2026-09-25T00:00:00.000Z'), '2026-09-25T00:00:00.000Z');
  });

  it('falls back to the epoch on an unparseable instant', () => {
    assert.equal(truncateToHour('not-a-date'), new Date(0).toISOString());
  });
});

describe('buildUsageEndpoint', () => {
  it('normalizes method and path and strips the query string', () => {
    assert.equal(buildUsageEndpoint('get', '/v1/obras/stock/moves'), 'GET /v1/obras/stock/moves');
    assert.equal(
      buildUsageEndpoint('post', '/v1/obras/stock/moves?verbose=true'),
      'POST /v1/obras/stock/moves',
    );
    assert.equal(buildUsageEndpoint('GET', 'v1/health'), 'GET /v1/health');
  });

  it('caps a crafted path and names a missing method', () => {
    const built = buildUsageEndpoint('get', `/${'a'.repeat(500)}`);
    assert.ok(built.length <= 200, 'the stored endpoint stays bounded');
    assert.ok(built.startsWith('GET /'));
    assert.equal(buildUsageEndpoint('', '/v1/health'), 'UNKNOWN /v1/health');
  });
});

describe('shouldCountUsage', () => {
  it('counts only API-key calls answered 2xx', () => {
    assert.equal(shouldCountUsage(API_KEY_ID, 200), true);
    assert.equal(shouldCountUsage(API_KEY_ID, 201), true);
    assert.equal(shouldCountUsage(API_KEY_ID, 299), true);
    assert.equal(shouldCountUsage(API_KEY_ID, 199), false);
    assert.equal(shouldCountUsage(API_KEY_ID, 300), false);
    assert.equal(shouldCountUsage(API_KEY_ID, 400), false);
    assert.equal(shouldCountUsage(API_KEY_ID, 500), false);
  });

  it('ignores JWT, local-header and malformed-key traffic', () => {
    assert.equal(shouldCountUsage(null, 200), false);
    assert.equal(shouldCountUsage(undefined, 200), false);
    assert.equal(shouldCountUsage('   ', 200), false);
    assert.equal(shouldCountUsage('not-a-uuid', 200), false);
  });
});

describe('recordApiKeyUsage', () => {
  it('upserts the (tenant, key, endpoint, hour) row in one statement', async () => {
    const db: FakeDb = { queries: [], fail: false };
    await recordApiKeyUsage(createFakeClient(db), {
      tenantId: TENANT_ID,
      apiKeyId: API_KEY_ID,
      endpoint: 'GET /v1/obras/stock/moves',
      at: '2026-09-25T10:37:12.456Z',
    });

    assert.equal(db.queries.length, 1);
    const issued = db.queries[0];
    assert.ok(issued !== undefined);
    assert.equal(issued.text, RECORD_USAGE_COUNTER_SQL);
    assert.ok(issued.text.includes('ON CONFLICT (tenant_id, api_key_id, endpoint, window_start)'));
    assert.ok(issued.text.includes('DO UPDATE SET count = usage_counters.count + 1'));
    assert.deepEqual(issued.values, [
      TENANT_ID,
      API_KEY_ID,
      'GET /v1/obras/stock/moves',
      '2026-09-25T10:00:00.000Z',
      USAGE_COUNTER_METRIC,
      '2026-09-25T10:00:00.000Z',
    ]);
  });

  it('issues no SQL for invalid ids or a blank endpoint', async () => {
    for (const input of [
      { tenantId: 'x', apiKeyId: API_KEY_ID, endpoint: 'GET /v1/health' },
      { tenantId: TENANT_ID, apiKeyId: null, endpoint: 'GET /v1/health' },
      { tenantId: TENANT_ID, apiKeyId: 'x', endpoint: 'GET /v1/health' },
      { tenantId: TENANT_ID, apiKeyId: API_KEY_ID, endpoint: '   ' },
    ]) {
      const db: FakeDb = { queries: [], fail: false };
      await recordApiKeyUsage(createFakeClient(db), input);
      assert.equal(db.queries.length, 0, `no SQL for ${JSON.stringify(input)}`);
    }
  });

  it('never throws: a database failure resolves after one attempt', async () => {
    const db: FakeDb = { queries: [], fail: true };
    await recordApiKeyUsage(createFakeClient(db), {
      tenantId: TENANT_ID,
      apiKeyId: API_KEY_ID,
      endpoint: 'GET /v1/health',
      at: '2026-09-25T10:00:00.000Z',
    });
    assert.equal(db.queries.length, 1, 'the writer tries once, then logs and resolves');
  });
});
