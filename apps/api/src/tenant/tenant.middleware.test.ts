// Tenant context contract + middleware lifecycle tests (bases-consolidadas-v1.md
// §4.2, §5.1 and odd/tasks/mvp1-api-runtime.md criterion 2).
//
// Two layers are covered without touching Postgres:
// - `resolveTenantContext` — the pure header parsing/validation used by the
//   middleware, exercised directly.
// - `TenantContextMiddleware` — the transaction lifecycle against a fake pool,
//   so BEGIN / set_config / COMMIT / ROLLBACK / release are asserted by
//   observing the emitted statements instead of a real connection.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PG_POOL,
  TenantContextMiddleware,
  resolveTenantContext,
  type TenantClient,
  type TenantPool,
} from './tenant.middleware.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const USER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** Headers as Express hands them to a Nest middleware. */
function headers(extra: Record<string, string | string[] | undefined> = {}) {
  return { 'x-tenant-id': TENANT_ID, 'x-user-id': USER_ID, ...extra };
}

// --- pure resolution --------------------------------------------------------

describe('resolveTenantContext', () => {
  it('rejects a request without the tenant header -> tenant.missing', () => {
    const result = resolveTenantContext(headers({ 'x-tenant-id': undefined }));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'tenant.missing');
    assert.equal(result.ok === false && result.status, 403);
  });

  it('rejects a blank tenant header -> tenant.missing', () => {
    const result = resolveTenantContext(headers({ 'x-tenant-id': '   ' }));
    assert.equal(result.ok === false && result.error.code, 'tenant.missing');
  });

  it('rejects a tenant header that is not a UUID v4 -> tenant.missing', () => {
    for (const value of ['not-a-uuid', '3f1c9b2e-4d1a-1e6f-8b2c-5a7d9e0f1a2b']) {
      const result = resolveTenantContext(headers({ 'x-tenant-id': value }));
      assert.equal(result.ok === false && result.error.code, 'tenant.missing', value);
    }
  });

  it('rejects a missing user header -> tenant.user_invalid', () => {
    const result = resolveTenantContext(headers({ 'x-user-id': undefined }));
    assert.equal(result.ok === false && result.error.code, 'tenant.user_invalid');
    assert.equal(result.ok === false && result.status, 403);
  });

  it('rejects a malformed user header -> tenant.user_invalid', () => {
    const result = resolveTenantContext(headers({ 'x-user-id': 'user-1' }));
    assert.equal(result.ok === false && result.error.code, 'tenant.user_invalid');
  });

  it('resolves tenant, user and scopes from valid headers', () => {
    const result = resolveTenantContext(
      headers({ 'x-scopes': 'crm-core,salud' }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok === true && result.context, {
      tenantId: TENANT_ID,
      userId: USER_ID,
      scopes: ['crm-core', 'salud'],
    });
  });

  it('defaults to an empty scope list when x-scopes is absent', () => {
    const result = resolveTenantContext(headers());
    assert.equal(result.ok === true && result.context.scopes.length, 0);
  });

  it('accepts space separated scopes and trims blanks', () => {
    const result = resolveTenantContext(headers({ 'x-scopes': ' crm-core  salud , ' }));
    assert.deepEqual(result.ok === true && result.context.scopes, ['crm-core', 'salud']);
  });

  it('reads the first value when a header repeats (Express string[])', () => {
    const result = resolveTenantContext(headers({ 'x-tenant-id': [TENANT_ID, 'other'] }));
    assert.equal(result.ok === true && result.context.tenantId, TENANT_ID);
  });

  it('is case insensitive on header names', () => {
    const result = resolveTenantContext({
      'X-Tenant-Id': TENANT_ID,
      'X-User-Id': USER_ID,
    });
    assert.equal(result.ok === true && result.context.tenantId, TENANT_ID);
  });
});

// --- middleware lifecycle ---------------------------------------------------

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

interface FakePoolState {
  pool: TenantPool;
  queries: RecordedQuery[];
  connectCalls: number;
  releases: Array<boolean | undefined>;
  client: TenantClient;
}

/** Pool double recording every statement and release. */
function createFakePool(options: { failConnect?: boolean } = {}): FakePoolState {
  const queries: RecordedQuery[] = [];
  const releases: Array<boolean | undefined> = [];
  const state: FakePoolState = {
    queries,
    releases,
    connectCalls: 0,
    pool: undefined as unknown as TenantPool,
    client: undefined as unknown as TenantClient,
  };
  const client: TenantClient = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: [] };
    },
    release(destroy?: boolean) {
      releases.push(destroy);
    },
  };
  state.client = client;
  state.pool = {
    async connect() {
      state.connectCalls += 1;
      if (options.failConnect) throw new Error('pool unreachable');
      return client;
    },
  };
  return state;
}

interface FakeResponseState {
  res: {
    statusCode: number;
    status(code: number): FakeResponseState['res'];
    json(payload: unknown): FakeResponseState['res'];
    on(event: string, handler: () => void): FakeResponseState['res'];
  };
  body: unknown;
  finish(code?: number): void;
  close(): void;
}

/** Minimal Express response double with 'finish'/'close' emitters. */
function createFakeResponse(): FakeResponseState {
  const listeners = new Map<string, Array<() => void>>();
  const state: FakeResponseState = {
    body: undefined,
    res: undefined as unknown as FakeResponseState['res'],
    finish(code?: number) {
      if (code !== undefined) state.res.statusCode = code;
      for (const handler of listeners.get('finish') ?? []) handler();
    },
    close() {
      for (const handler of listeners.get('close') ?? []) handler();
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

/** Waits for the fire-and-forget finalization to settle. */
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

function requestWith(extra: Record<string, string> = {}) {
  return {
    headers: headers(extra),
    tenant: undefined,
    tenantClient: undefined,
  };
}

describe('TenantContextMiddleware', () => {
  it('sets the RLS context inside a transaction and commits on finish', async () => {
    const state = createFakePool();
    const middleware = new TenantContextMiddleware(state.pool);
    const req = requestWith({ 'x-scopes': 'crm-core' });
    const res = createFakeResponse();
    const forwarded: unknown[] = [];

    await middleware.use(req, res.res, (error?: unknown) => forwarded.push(error));

    assert.deepEqual(forwarded, [undefined], 'handler chain keeps running');
    assert.equal(req.tenant?.tenantId, TENANT_ID, 'context reaches the handlers');
    assert.equal(req.tenantClient, state.client, 'client reaches the handlers');
    assert.deepEqual(
      state.queries.map((entry) => entry.text),
      ['BEGIN', SET_TENANT, SET_USER, SET_SCOPES],
    );
    assert.deepEqual(state.queries[1].values, [TENANT_ID]);
    assert.deepEqual(state.queries[2].values, [USER_ID]);
    assert.deepEqual(state.queries[3].values, ['crm-core']);

    res.finish(200);
    await settle(() => state.releases.length === 1);

    assert.equal(state.queries.at(-1)?.text, 'COMMIT');
    assert.deepEqual(state.releases, [undefined]);
  });

  it('answers 403 tenant.missing without taking a pooled connection', async () => {
    const state = createFakePool();
    const middleware = new TenantContextMiddleware(state.pool);
    const req = { headers: {}, tenant: undefined, tenantClient: undefined };
    const res = createFakeResponse();
    const forwarded: unknown[] = [];

    await middleware.use(req, res.res, (error?: unknown) => forwarded.push(error));

    assert.equal(res.res.statusCode, 403);
    assert.deepEqual(res.body, {
      code: 'tenant.missing',
      message: 'Missing or malformed x-tenant-id header (expected a UUID v4)',
      traceId: res.body && (res.body as { traceId: string }).traceId,
    });
    assert.equal(typeof (res.body as { traceId: string }).traceId, 'string');
    assert.ok((res.body as { traceId: string }).traceId.length > 0);
    assert.deepEqual(forwarded, [], 'the handler chain is not invoked');
    assert.equal(state.connectCalls, 0);
  });

  it('echoes the incoming trace id on a rejection', async () => {
    const state = createFakePool();
    const middleware = new TenantContextMiddleware(state.pool);
    const res = createFakeResponse();

    await middleware.use(
      { headers: { 'x-trace-id': 'trace-42' } },
      res.res,
      () => undefined,
    );

    assert.equal((res.body as { traceId: string }).traceId, 'trace-42');
    assert.equal(state.connectCalls, 0);
  });

  it('rolls back and releases when the handler failed (5xx)', async () => {
    const state = createFakePool();
    const middleware = new TenantContextMiddleware(state.pool);
    const res = createFakeResponse();

    await middleware.use(requestWith(), res.res, () => undefined);
    res.finish(500);
    await settle(() => state.releases.length === 1);

    assert.equal(state.queries.at(-1)?.text, 'ROLLBACK');
    assert.deepEqual(state.releases, [undefined]);
  });

  it('rolls back when the client disconnects before the response finishes', async () => {
    const state = createFakePool();
    const middleware = new TenantContextMiddleware(state.pool);
    const res = createFakeResponse();

    await middleware.use(requestWith(), res.res, () => undefined);
    res.close();
    await settle(() => state.releases.length === 1);

    assert.equal(state.queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(state.releases.length, 1, 'release happens exactly once');
  });

  it('forwards a pool failure to next() instead of crashing', async () => {
    const state = createFakePool({ failConnect: true });
    const middleware = new TenantContextMiddleware(state.pool);
    const res = createFakeResponse();
    const forwarded: unknown[] = [];

    await middleware.use(requestWith(), res.res, (error?: unknown) => forwarded.push(error));

    assert.equal(forwarded.length, 1);
    assert.match(String(forwarded[0]), /pool unreachable/);
    assert.equal(res.body, undefined, 'no response is written by the middleware');
  });

  it('keeps one pooled client per request (no cross-request reuse)', async () => {
    const state = createFakePool();
    const middleware = new TenantContextMiddleware(state.pool);
    const first = createFakeResponse();
    const second = createFakeResponse();

    await middleware.use(requestWith(), first.res, () => undefined);
    await middleware.use(requestWith(), second.res, () => undefined);
    first.finish(200);
    second.finish(200);
    await settle(() => state.releases.length === 2);

    assert.equal(state.connectCalls, 2);
    assert.equal(state.queries.filter((entry) => entry.text === 'BEGIN').length, 2);
    assert.equal(state.queries.filter((entry) => entry.text === 'COMMIT').length, 2);
  });

  it('exposes PG_POOL as the injection token used by the module', () => {
    assert.equal(typeof PG_POOL, 'string');
    assert.ok(PG_POOL.length > 0);
  });
});
