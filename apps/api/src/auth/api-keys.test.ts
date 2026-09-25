// API key coverage (W1): digest-only secret handling, tenant-admin gate,
// management use cases and the `X-Api-Key` middleware branch.
//
// The SQL client is a small stateful in-memory double: it implements the exact
// statements `auth/api-keys.ts` and the middleware issue over synthetic rows,
// so the suite exercises the real control flow (guard, hashing, revocation)
// without Postgres. All data is synthetic.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  API_KEY_INVALID_CODE,
  createApiKey,
  generateApiKeySecret,
  hashApiKeySecret,
  isTenantAdminRole,
  listApiKeys,
  parseApiKeyCreateInput,
  revokeApiKey,
  verifyApiKey,
  type ApiKeyActor,
  type ApiKeyClient,
} from './api-keys.ts';
import { TenantContextMiddleware } from '../tenant/tenant.middleware.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const ADMIN_USER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PLAIN_USER_ID = 'b1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ORG_NODE_ID = 'c1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const KEY_ID = 'd1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const TRACE = 'trace-api-keys-1';
const FUTURE = '2099-01-01T00:00:00.000Z';

// ============ in-memory double ============

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  /** Membership row answered to the guard lookup (`null` = no membership). */
  membership: Record<string, unknown> | null;
  /** Rows answered to the management list. */
  keys: Record<string, unknown>[];
  /** `false` simulates a revoked key at the verifier (next-request effect). */
  keyValid: boolean;
  queries: RecordedQuery[];
  auditActions: unknown[];
}

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: 'e1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    user_id: ADMIN_USER_ID,
    tenant_id: TENANT_ID,
    org_node_id: ORG_NODE_ID,
    role,
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

function keyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: KEY_ID,
    tenant_id: TENANT_ID,
    name: 'CI / facturacion',
    key_prefix: 'a1b2c3d4',
    scopes: ['billing.read'],
    active: true,
    valid_from: '2026-09-25T10:00:00.000Z',
    valid_to: null,
    created_at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function createFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    membership: membershipRow('ti_admin'),
    keys: [keyRow()],
    keyValid: true,
    queries: [],
    auditActions: [],
    ...overrides,
  };
}

/** Dispatches on the statement markers the service/middleware emit. */
function createFakeClient(db: FakeDb): ApiKeyClient {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      db.queries.push({ text, values });
      if (text.includes('FROM memberships m')) {
        return { rows: db.membership === null ? [] : [db.membership] };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: [{ id: ORG_NODE_ID }] };
      }
      if (text.includes('INSERT INTO api_keys')) {
        return {
          rows: [
            {
              id: 'f1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              tenant_id: values[0],
              name: values[1],
              key_hash: values[2],
              key_prefix: values[3],
              scopes: values[4],
              active: true,
              valid_from: new Date().toISOString(),
              valid_to: values[5],
              created_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (text.includes('FROM api_keys WHERE')) {
        return { rows: db.keys };
      }
      if (text.includes('UPDATE api_keys')) {
        const found = db.keys.find((row) => row.id === values[0] && row.tenant_id === values[1]);
        if (found === undefined) return { rows: [] };
        return { rows: [{ ...found, active: false }] };
      }
      if (text.includes('INSERT INTO audit_log')) {
        db.auditActions.push(values[2]);
        return { rows: [] };
      }
      if (text.includes('FROM verify_api_key')) {
        if (!db.keyValid) return { rows: [] };
        return { rows: [{ key_id: KEY_ID, tenant_id: TENANT_ID, scopes: ['billing.read'] }] };
      }
      return { rows: [] };
    },
  };
}

function actorFor(db: FakeDb, userId: string = ADMIN_USER_ID): ApiKeyActor {
  return { client: createFakeClient(db), tenantId: TENANT_ID, userId, traceId: TRACE, ip: null };
}

function statusOf(error: unknown): number {
  assert.ok(error instanceof HttpException);
  return error.getStatus();
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof HttpException);
  return (error.getResponse() as { code: string }).code;
}

// ============ secret handling ============

describe('api key secrets', () => {
  it('hashes deterministically to 64 hex chars without the secret', () => {
    const first = hashApiKeySecret('rizoma_opaque');
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, hashApiKeySecret('rizoma_opaque'));
    assert.ok(!first.includes('rizoma_opaque'));
    assert.notEqual(first, hashApiKeySecret('rizoma_other'));
  });

  it('generates unique prefixed secrets whose digest verifies', () => {
    const first = generateApiKeySecret();
    const second = generateApiKeySecret();
    assert.ok(first.secret.startsWith('rizoma_'));
    assert.equal(first.keyHash, hashApiKeySecret(first.secret));
    assert.equal(first.keyPrefix, first.keyHash.slice(0, 8));
    assert.notEqual(first.secret, second.secret);
  });

  it('verifies a known digest and rejects unknown or blank secrets', async () => {
    const db = createFakeDb();
    const client = createFakeClient(db);
    const verified = await verifyApiKey(client, 'rizoma_anything');
    assert.deepEqual(verified, { keyId: KEY_ID, tenantId: TENANT_ID, scopes: ['billing.read'] });

    db.keyValid = false;
    assert.equal(await verifyApiKey(client, 'rizoma_anything'), null);
    assert.equal(await verifyApiKey(client, '   '), null);
  });

  it('recognizes the tenant admin roles only', () => {
    assert.equal(isTenantAdminRole('ti_admin'), true);
    assert.equal(isTenantAdminRole('direccion'), true);
    assert.equal(isTenantAdminRole('medico'), false);
    assert.equal(isTenantAdminRole('caja'), false);
    assert.equal(isTenantAdminRole('unknown'), false);
  });
});

// ============ input validation ============

describe('parseApiKeyCreateInput', () => {
  it('applies defaults for scopes and expiry', () => {
    assert.deepEqual(parseApiKeyCreateInput({ name: 'ETL' }, TRACE), {
      name: 'ETL',
      scopes: [],
      validTo: null,
    });
  });

  it('trims the name and the scopes', () => {
    const parsed = parseApiKeyCreateInput({ name: '  CI  ', scopes: [' billing.read '] }, TRACE);
    assert.equal(parsed.name, 'CI');
    assert.deepEqual(parsed.scopes, ['billing.read']);
  });

  it('rejects a non-object body, a blank name and bad scopes', () => {
    for (const body of [null, 'x', [], {}, { name: '' }, { name: 'x'.repeat(121) }]) {
      assert.equal(codeOf(catchSync(() => parseApiKeyCreateInput(body, TRACE))), 'validation.failed');
    }
    assert.equal(
      codeOf(catchSync(() => parseApiKeyCreateInput({ name: 'CI', scopes: 'billing.read' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(catchSync(() => parseApiKeyCreateInput({ name: 'CI', scopes: [''] }, TRACE))),
      'validation.failed',
    );
  });

  it('rejects a malformed or past expiry', () => {
    assert.equal(
      codeOf(catchSync(() => parseApiKeyCreateInput({ name: 'CI', validTo: 'ayer' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(
        catchSync(() => parseApiKeyCreateInput({ name: 'CI', validTo: '2020-01-01T00:00:00.000Z' }, TRACE)),
      ),
      'validation.failed',
    );
  });
});

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

// ============ management use cases ============

describe('createApiKey', () => {
  it('issues one key and returns the secret exactly once', async () => {
    const db = createFakeDb();
    const created = await createApiKey(actorFor(db), { name: 'CI', scopes: ['billing.read'] });

    assert.ok(created.secret.startsWith('rizoma_'));
    assert.equal(created.name, 'CI');
    assert.equal(created.active, true);
    assert.ok(!Object.hasOwn({ ...created, secret: undefined }, 'key_hash'));
    const insert = db.queries.find((entry) => entry.text.includes('INSERT INTO api_keys'));
    assert.ok(insert !== undefined, 'the key row is inserted');
    // Digest-only storage: the stored hash verifies the returned secret, and
    // the clear secret is nowhere in the bound values.
    assert.equal(insert.values[2], hashApiKeySecret(created.secret));
    for (const value of insert.values) {
      assert.ok(value !== created.secret, 'the clear secret is never bound to SQL');
    }
    assert.ok(db.auditActions.includes('api_key.issued'), 'the issue is audited');
  });

  it('denies a non-admin role with access.denied and inserts nothing', async () => {
    const db = createFakeDb({ membership: membershipRow('medico') });
    const error = await createApiKey(actorFor(db), { name: 'CI' }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 403);
    assert.equal(codeOf(error), 'access.denied');
    assert.equal(
      db.queries.some((entry) => entry.text.includes('INSERT INTO api_keys')),
      false,
    );
    assert.ok(db.auditActions.includes('access.denied'), 'the denial is audited');
  });

  it('denies a caller without membership and an API-key caller', async () => {
    const db = createFakeDb({ membership: null });
    // Human without membership ...
    const human = await createApiKey(actorFor(db, PLAIN_USER_ID), { name: 'CI' }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(human), 'access.denied');
    // ... and a machine caller (userId = key id) alike: keys cannot mint keys.
    const machine = await createApiKey(actorFor(db, KEY_ID), { name: 'CI' }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(machine), 'access.denied');
  });

  it('answers 400 on a bad body before touching the database', async () => {
    const db = createFakeDb();
    const error = await createApiKey(actorFor(db), { name: '' }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 400);
    assert.equal(db.queries.length, 0, 'no query runs on a validation failure');
  });
});

describe('listApiKeys', () => {
  it('lists rows without secrets or hashes for an admin', async () => {
    const db = createFakeDb();
    const rows = await listApiKeys(actorFor(db));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.keyPrefix, 'a1b2c3d4');
    assert.deepEqual(rows[0]?.scopes, ['billing.read']);
    assert.ok(!Object.hasOwn(rows[0] as object, 'secret'));
    assert.ok(!Object.hasOwn(rows[0] as object, 'key_hash'));
  });

  it('denies a non-admin role with access.denied', async () => {
    const db = createFakeDb({ membership: membershipRow('caja') });
    const error = await listApiKeys(actorFor(db)).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 403);
    assert.equal(codeOf(error), 'access.denied');
  });
});

describe('revokeApiKey', () => {
  it('deactivates the key, audits, and stays idempotent', async () => {
    const db = createFakeDb();
    const revoked = await revokeApiKey(actorFor(db), KEY_ID);
    assert.equal(revoked.active, false);
    assert.ok(db.auditActions.includes('api_key.revoked'));

    const again = await revokeApiKey(actorFor(db), KEY_ID);
    assert.equal(again.active, false, 'a second revoke answers the row again');
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const db = createFakeDb({ keys: [] });
    const missing = await revokeApiKey(actorFor(db), KEY_ID).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(missing), 404);
    assert.equal(codeOf(missing), 'not_found');

    const malformed = await revokeApiKey(actorFor(db), 'not-a-uuid').then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(malformed), 400);
  });

  it('denies a non-admin role', async () => {
    const db = createFakeDb({ membership: membershipRow('trabajador') });
    const error = await revokeApiKey(actorFor(db), KEY_ID).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(error), 'access.denied');
  });
});

// ============ middleware branch ============

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

function createMiddlewarePool(db: FakeDb): {
  pool: { connect(): Promise<{ query(t: string, v?: readonly unknown[]): Promise<unknown>; release(d?: boolean): void }> };
  queries: RecordedQuery[];
  releases: Array<boolean | undefined>;
} {
  const queries: RecordedQuery[] = [];
  const releases: Array<boolean | undefined> = [];
  const client = createFakeClient(db);
  return {
    queries,
    releases,
    pool: {
      async connect() {
        return {
          async query(text: string, values?: readonly unknown[]) {
            queries.push({ text, values });
            return client.query(text, values);
          },
          release(destroy?: boolean) {
            releases.push(destroy);
          },
        };
      },
    },
  };
}

function createFakeResponse(): {
  res: {
    statusCode: number;
    status(code: number): unknown;
    json(payload: unknown): unknown;
    on(event: string, handler: () => void): unknown;
  };
  body: unknown;
  finish(code?: number): void;
} {
  const listeners = new Map<string, Array<() => void>>();
  const state = {
    body: undefined as unknown,
    res: undefined as unknown as {
      statusCode: number;
      status(code: number): unknown;
      json(payload: unknown): unknown;
      on(event: string, handler: () => void): unknown;
    },
    finish(code?: number) {
      if (code !== undefined) state.res.statusCode = code;
      for (const handler of listeners.get('finish') ?? []) handler();
    },
  };
  state.res = {
    statusCode: 200,
    status(code: number) {
      state.res.statusCode = code;
      return state.res;
    },
    json(payload: unknown) {
      state.body = payload;
      return state.res;
    },
    on(event: string, handler: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return state.res;
    },
  };
  return state;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function settle(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (done()) return;
    await flush();
  }
  throw new Error('middleware did not settle');
}

const SET_TENANT = "SELECT set_config('app.tenant_id', $1, true)";
const SET_USER = "SELECT set_config('app.user_id', $1, true)";
const SET_SCOPES = "SELECT set_config('app.scopes', $1, true)";

describe('TenantContextMiddleware X-Api-Key branch', () => {
  it('resolves the key before Bearer and binds tenant + key scopes', async () => {
    const db = createFakeDb();
    const { pool, queries, releases } = createMiddlewarePool(db);
    const middleware = new TenantContextMiddleware(pool);
    const req: { headers: Record<string, string>; tenant?: unknown; tenantClient?: unknown } = {
      headers: {
        'x-api-key': 'rizoma_presented_secret',
        authorization: 'Bearer invalid-but-ignored',
      },
    };
    const res = createFakeResponse();
    const forwarded: unknown[] = [];

    await middleware.use(
      req as Parameters<TenantContextMiddleware['use']>[0],
      res.res as Parameters<TenantContextMiddleware['use']>[1],
      (error?: unknown) => forwarded.push(error),
    );

    assert.deepEqual(forwarded, [undefined]);
    assert.deepEqual(req.tenant, {
      tenantId: TENANT_ID,
      userId: KEY_ID,
      scopes: ['billing.read'],
    });
    const statements = queries.map((entry) => entry.text);
    assert.ok(statements[0] === 'BEGIN');
    assert.ok(statements.includes('SELECT key_id, tenant_id, scopes FROM verify_api_key($1)'));
    assert.deepEqual(queries.find((entry) => entry.text === SET_TENANT)?.values, [TENANT_ID]);
    assert.deepEqual(queries.find((entry) => entry.text === SET_USER)?.values, [KEY_ID]);
    assert.deepEqual(queries.find((entry) => entry.text === SET_SCOPES)?.values, ['billing.read']);

    res.finish(200);
    await settle(() => releases.length === 2);
    assert.ok(queries.some((entry) => entry.text === 'COMMIT'));
    assert.ok(
      queries.some((entry) => entry.text.startsWith('INSERT INTO usage_counters')),
      'api-key traffic records one hourly usage row on a short client',
    );
  });

  it('rejects an unknown key with 401 auth.api_key_invalid and rolls back', async () => {
    const db = createFakeDb({ keyValid: false });
    const { pool, queries } = createMiddlewarePool(db);
    const middleware = new TenantContextMiddleware(pool);
    const req = { headers: { 'x-api-key': 'rizoma_unknown' } };
    const res = createFakeResponse();
    const forwarded: unknown[] = [];

    await middleware.use(
      req as Parameters<TenantContextMiddleware['use']>[0],
      res.res as Parameters<TenantContextMiddleware['use']>[1],
      (error?: unknown) => forwarded.push(error),
    );

    assert.equal(res.res.statusCode, 401);
    assert.equal((res.body as { code: string }).code, API_KEY_INVALID_CODE);
    assert.equal((res.body as { code: string }).code, 'auth.api_key_invalid');
    assert.equal(typeof (res.body as { traceId: string }).traceId, 'string');
    assert.deepEqual(forwarded, [], 'the handler chain is not invoked');
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
  });

  it('sees a revocation on the very next request (no permission cache)', async () => {
    const db = createFakeDb();
    const { pool } = createMiddlewarePool(db);
    const middleware = new TenantContextMiddleware(pool);
    const headers = { 'x-api-key': 'rizoma_presented_secret' };

    const first = createFakeResponse();
    const firstForwarded: unknown[] = [];
    await middleware.use(
      { headers } as Parameters<TenantContextMiddleware['use']>[0],
      first.res as Parameters<TenantContextMiddleware['use']>[1],
      (error?: unknown) => firstForwarded.push(error),
    );
    assert.deepEqual(firstForwarded, [undefined]);
    first.finish(200);

    db.keyValid = false; // revocation lands between the two requests
    const second = createFakeResponse();
    await middleware.use(
      { headers } as Parameters<TenantContextMiddleware['use']>[0],
      second.res as Parameters<TenantContextMiddleware['use']>[1],
      () => undefined,
    );
    assert.equal(second.res.statusCode, 401);
    assert.equal((second.body as { code: string }).code, 'auth.api_key_invalid');
  });

  it('treats a blank X-Api-Key as absent and keeps the header path', async () => {
    const db = createFakeDb();
    const { pool } = createMiddlewarePool(db);
    const middleware = new TenantContextMiddleware(pool);
    const req = {
      headers: { 'x-api-key': '   ', 'x-tenant-id': TENANT_ID, 'x-user-id': ADMIN_USER_ID },
    };
    const res = createFakeResponse();
    const forwarded: unknown[] = [];

    await middleware.use(
      req as Parameters<TenantContextMiddleware['use']>[0],
      res.res as Parameters<TenantContextMiddleware['use']>[1],
      (error?: unknown) => forwarded.push(error),
    );

    assert.deepEqual(forwarded, [undefined]);
    assert.equal((req as { tenant?: { tenantId: string } }).tenant?.tenantId, TENANT_ID);
  });
});
