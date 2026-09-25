// Board-cache coverage (R2): key shape, TTLs, JSON round trip, fail-open and
// the cache-aside wrapping of the three boards (salud role, obras site and
// obras company).
//
// Redis is an in-memory double (`Map`), so the suite exercises the real
// `cache/boards.ts` contract plus the real dashboard services without Redis or
// Postgres. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOARD_COMPARE_KEY_SUFFIX,
  OBRAS_BOARD_TTL_SECONDS,
  SALUD_BOARD_TTL_SECONDS,
  getBoard,
  obrasCompanyBoardKey,
  obrasCompanyComparedBoardKey,
  obrasSiteBoardKey,
  obrasSiteComparedBoardKey,
  saludBoardKey,
  saludComparedBoardKey,
  scrubCacheSegment,
  setBoard,
  withBoardCache,
  type BoardCacheClient,
} from './boards.ts';
import { getBoard as getSaludBoard, exportBoard as exportSaludBoard } from '../salud/dashboards.service.ts';
import type { ActorContext, SaludClient } from '../salud/salud.service.ts';
import {
  getCompanyBoard,
  getComparedCompanyBoard,
  getSiteBoard,
} from '../obras/dashboards.service.ts';
import type { ObraActorContext, ObraClient } from '../obras/obras.service.ts';

// ============ in-memory Redis double ============

interface SetexCall {
  readonly key: string;
  readonly ttlSeconds: number;
}

class FakeRedis implements BoardCacheClient {
  private readonly store = new Map<string, string>();
  readonly setexCalls: SetexCall[] = [];
  private readonly failing: boolean;

  constructor(failing = false) {
    this.failing = failing;
  }

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('redis.down');
    return this.store.get(key) ?? null;
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<string> {
    if (this.failing) throw new Error('redis.down');
    this.setexCalls.push({ key, ttlSeconds });
    this.store.set(key, value);
    return 'OK';
  }

  /** Bypasses the client to plant a raw (possibly corrupt) payload. */
  plant(key: string, raw: string): void {
    this.store.set(key, raw);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

// ============ key shape ============

describe('board cache keys', () => {
  it('namespaces the salud board key per tenant, role, org and day', () => {
    assert.equal(
      saludBoardKey('tenant-1', 'recepcion', 'org-9', '2026-09-25'),
      'rizoma:v1:tenant-1:salud:board:recepcion:org-9:2026-09-25',
    );
  });

  it('namespaces the obras site and company keys', () => {
    assert.equal(
      obrasSiteBoardKey('tenant-1', 'site-7', '2026-09-25'),
      'rizoma:v1:tenant-1:obras:site:site-7:2026-09-25',
    );
    assert.equal(
      obrasCompanyBoardKey('tenant-1', 'org-9', '2026-09-25'),
      'rizoma:v1:tenant-1:obras:company:org-9:2026-09-25',
    );
  });

  it('holds every comparison under its own :prev7d key', () => {
    assert.equal(BOARD_COMPARE_KEY_SUFFIX, ':prev7d');
    assert.equal(
      saludComparedBoardKey('t', 'caja', 'o', '2026-09-25'),
      `${saludBoardKey('t', 'caja', 'o', '2026-09-25')}:prev7d`,
    );
    assert.equal(
      obrasSiteComparedBoardKey('t', 's', '2026-09-25'),
      `${obrasSiteBoardKey('t', 's', '2026-09-25')}:prev7d`,
    );
    assert.equal(
      obrasCompanyComparedBoardKey('t', 'o', '2026-09-25'),
      `${obrasCompanyBoardKey('t', 'o', '2026-09-25')}:prev7d`,
    );
  });

  it('scrubs hostile segments so none can inject a separator', () => {
    assert.equal(scrubCacheSegment('a:b/c'), 'a-b-c');
    assert.equal(
      saludBoardKey('t', 'recepcion', 'o:x', '2026-09-25'),
      'rizoma:v1:t:salud:board:recepcion:o-x:2026-09-25',
    );
  });

  it('uses 900s for salud and 300s for obras', () => {
    assert.equal(SALUD_BOARD_TTL_SECONDS, 900);
    assert.equal(OBRAS_BOARD_TTL_SECONDS, 300);
  });
});

// ============ get/set + fail-open ============

describe('getBoard/setBoard', () => {
  it('round-trips a JSON value', async () => {
    const redis = new FakeRedis();
    await setBoard(redis, 'k', { role: 'caja', total: 3 }, 900);
    assert.deepEqual(await getBoard<{ role: string; total: number }>(redis, 'k'), {
      role: 'caja',
      total: 3,
    });
  });

  it('misses resolve to null without touching the loader path', async () => {
    const redis = new FakeRedis();
    assert.equal(await getBoard(redis, 'missing'), null);
  });

  it('treats a corrupt payload as a miss', async () => {
    const redis = new FakeRedis();
    redis.plant('k', '{not-json');
    assert.equal(await getBoard(redis, 'k'), null);
  });

  it('never throws when Redis is down', async () => {
    const redis = new FakeRedis(true);
    assert.equal(await getBoard(redis, 'k'), null);
    await setBoard(redis, 'k', { a: 1 }, 300);
  });

  it('is a no-op without a client', async () => {
    assert.equal(await getBoard(undefined, 'k'), null);
    await setBoard(null, 'k', { a: 1 }, 300);
  });
});

describe('withBoardCache', () => {
  it('runs the loader once on a miss and serves the hit after', async () => {
    const redis = new FakeRedis();
    let loads = 0;
    const loader = async (): Promise<{ n: number }> => {
      loads += 1;
      return { n: loads };
    };
    assert.deepEqual(await withBoardCache(redis, 'k', 300, loader), { n: 1 });
    assert.deepEqual(await withBoardCache(redis, 'k', 300, loader), { n: 1 });
    assert.equal(loads, 1);
  });

  it('propagates loader failures instead of caching them', async () => {
    const redis = new FakeRedis();
    await assert.rejects(async () =>
      withBoardCache(redis, 'k', 300, async () => {
        throw new Error('primary.down');
      }),
    );
    assert.equal(await getBoard(redis, 'k'), null);
  });

  it('reads the primary when Redis is down and never 500s for cache reasons', async () => {
    const redis = new FakeRedis(true);
    let loads = 0;
    const value = await withBoardCache(redis, 'k', 300, async () => {
      loads += 1;
      return { n: loads };
    });
    assert.deepEqual(value, { n: 1 });
    assert.equal(loads, 1);
  });
});

// ============ service wrapping: salud ============

const SALUD_TENANT = 'a1000000-0000-4000-8000-0000000000aa';
const SALUD_SEDE = 'b1000000-0000-4000-8000-0000000000a1';
const SALUD_USER = 'c1000000-0000-4000-8000-0000000000a1';
const SALUD_DAY = '2026-09-25';

function createSaludDb(): { client: SaludClient; boardSql: () => number } {
  const queries: { text: string }[] = [];
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text });
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: 'd1000000-0000-4000-8000-0000000000a1',
              user_id: SALUD_USER,
              tenant_id: SALUD_TENANT,
              org_node_id: SALUD_SEDE,
              role: 'recepcion',
              scopes: [],
              active: true,
              valid_from: '2025-01-01T00:00:00.000Z',
              valid_to: null,
              user_active: true,
            },
          ],
        };
      }
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SALUD_SEDE }] };
      if (text.includes('SELECT modules FROM tenants')) return { rows: [{ modules: ['salud'] }] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('today_appointments')) {
        void values;
        return {
          rows: [{ today_appointments: '10', waiting_avg_min: '12.5', no_shows: '1', queue: '4' }],
        };
      }
      return { rows: [] };
    },
  };
  return { client, boardSql: () => queries.filter((query) => query.text.includes('today_appointments')).length };
}

function saludActor(client: SaludClient): ActorContext {
  return { client, tenantId: SALUD_TENANT, userId: SALUD_USER, roles: [], traceId: 'trace-cache-1', ip: null };
}

describe('salud board cache-aside', () => {
  it('runs the board SQL once per day and serves polls from Redis with SETEX 900', async () => {
    const db = createSaludDb();
    const redis = new FakeRedis();
    const first = await getSaludBoard(saludActor(db.client), 'recepcion', undefined, SALUD_DAY, redis);
    const second = await getSaludBoard(saludActor(db.client), 'recepcion', undefined, SALUD_DAY, redis);
    assert.deepEqual(second, first);
    assert.equal(db.boardSql(), 1);
    assert.equal(redis.setexCalls.length, 1);
    assert.equal(redis.setexCalls[0]?.key, saludBoardKey(SALUD_TENANT, 'recepcion', SALUD_SEDE, SALUD_DAY));
    assert.equal(redis.setexCalls[0]?.ttlSeconds, SALUD_BOARD_TTL_SECONDS);
  });

  it('reads the primary when Redis is down', async () => {
    const db = createSaludDb();
    const board = await getSaludBoard(
      saludActor(db.client),
      'recepcion',
      undefined,
      SALUD_DAY,
      new FakeRedis(true),
    );
    if (board.role !== 'recepcion') assert.fail('expected a recepcion board');
    assert.equal(board.todayAppointments, 10);
    assert.equal(db.boardSql(), 1);
  });

  it('shares the board key with the CSV export', async () => {
    const db = createSaludDb();
    const redis = new FakeRedis();
    await getSaludBoard(saludActor(db.client), 'recepcion', undefined, SALUD_DAY, redis);
    await exportSaludBoard(saludActor(db.client), 'recepcion', undefined, SALUD_DAY, 'csv', redis);
    assert.equal(db.boardSql(), 1);
  });
});

// ============ service wrapping: obras ============

const OBRAS_TENANT = 'a2000000-0000-4000-8000-0000000000a1';
const OBRAS_EMPRESA = 'b2000000-0000-4000-8000-000000000001';
const OBRAS_NODE = 'b2000000-0000-4000-8000-000000000003';
const OBRAS_SITE = 'c2000000-0000-4000-8000-000000000001';
const OBRAS_USER = 'd2000000-0000-4000-8000-000000000001';
const OBRAS_DAY = '2026-09-25';

function createObrasDb(): { client: ObraClient; boardSql: () => number; aggregateSql: () => number } {
  const queries: { text: string }[] = [];
  const client: ObraClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text });
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: 'e2000000-0000-4000-8000-000000000001',
              user_id: OBRAS_USER,
              tenant_id: OBRAS_TENANT,
              org_node_id: OBRAS_EMPRESA,
              role: 'gerente',
              scopes: [],
              active: true,
              valid_from: '2025-01-01T00:00:00.000Z',
              valid_to: null,
              user_active: true,
            },
          ],
        };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: [{ id: OBRAS_EMPRESA }, { id: OBRAS_NODE }] };
      }
      if (text.includes('SELECT modules FROM tenants')) return { rows: [{ modules: ['obras'] }] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        return {
          rows: [
            {
              id: OBRAS_SITE,
              tenant_id: OBRAS_TENANT,
              org_node_id: OBRAS_NODE,
              code: 'OBR-A',
              name: 'Obra OBR-A',
              client_name: 'Cliente Ficticio',
              budget_total: 100000,
              started_at: '2025-01-15T00:00:00.000Z',
              ended_at: null,
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('FROM assignments')) return { rows: [] };
      if (text.includes('FROM budget_lines')) {
        void values;
        return {
          rows: [
            {
              budget_line_id: 'b3000000-0000-4000-8000-000000000001',
              description: 'Excavacion',
              qty_planned: '100',
              qty_done: '40',
            },
          ],
        };
      }
      if (text.includes('GROUP BY status')) {
        return { rows: [{ status: 'registered', total: '3' }] };
      }
      if (text.includes('FROM inventory_items')) return { rows: [] };
      if (text.includes('FROM assets')) return { rows: [] };
      if (text.includes('FROM milestones')) return { rows: [] };
      if (text.includes('COUNT(*) AS total') && text.includes('FROM sites')) {
        return { rows: [{ total: '2', active: '1', planned: '1', closed: '0' }] };
      }
      if (text.includes('SUM(b.qty_planned)')) return { rows: [{ qty_planned: '100' }] };
      if (text.includes('SUM(p.qty_done)')) return { rows: [{ qty_done: '40' }] };
      return { rows: [] };
    },
  };
  return {
    client,
    boardSql: () => queries.filter((query) => query.text.includes('FROM budget_lines')).length,
    aggregateSql: () =>
      queries.filter(
        (query) =>
          query.text.includes('SUM(b.qty_planned)') || query.text.includes('SUM(p.qty_done)'),
      ).length,
  };
}

function obrasActor(client: ObraClient): ObraActorContext {
  return { client, tenantId: OBRAS_TENANT, userId: OBRAS_USER, roles: [], traceId: 'trace-cache-2', ip: null };
}

describe('obras board cache-aside', () => {
  it('runs the site SQL once per day and serves polls from Redis with SETEX 300', async () => {
    const db = createObrasDb();
    const redis = new FakeRedis();
    const first = await getSiteBoard(obrasActor(db.client), OBRAS_SITE, OBRAS_DAY, redis);
    const second = await getSiteBoard(obrasActor(db.client), OBRAS_SITE, OBRAS_DAY, redis);
    assert.deepEqual(second, first);
    assert.equal(db.boardSql(), 1);
    assert.equal(redis.setexCalls.length, 1);
    assert.equal(redis.setexCalls[0]?.key, obrasSiteBoardKey(OBRAS_TENANT, OBRAS_SITE, OBRAS_DAY));
    assert.equal(redis.setexCalls[0]?.ttlSeconds, OBRAS_BOARD_TTL_SECONDS);
  });

  it('caches the company aggregates under the membership org key', async () => {
    const db = createObrasDb();
    const redis = new FakeRedis();
    const first = await getCompanyBoard(obrasActor(db.client), OBRAS_DAY, redis);
    const second = await getCompanyBoard(obrasActor(db.client), OBRAS_DAY, redis);
    assert.deepEqual(second, first);
    assert.equal(db.aggregateSql(), 2);
    assert.ok(
      redis.setexCalls.some(
        (call) =>
          call.key === obrasCompanyBoardKey(OBRAS_TENANT, OBRAS_EMPRESA, OBRAS_DAY) &&
          call.ttlSeconds === OBRAS_BOARD_TTL_SECONDS,
      ),
    );
  });

  it('holds the company comparison under its own :prev7d key and skips the previous leg on hit', async () => {
    const db = createObrasDb();
    const redis = new FakeRedis();
    const first = await getComparedCompanyBoard(obrasActor(db.client), OBRAS_DAY, 'previous-week', redis);
    const afterFirst = db.aggregateSql();
    assert.equal(afterFirst, 4);
    const second = await getComparedCompanyBoard(obrasActor(db.client), OBRAS_DAY, 'previous-week', redis);
    assert.deepEqual(second, first);
    assert.equal(db.aggregateSql(), afterFirst);
    const envelopeKey = obrasCompanyComparedBoardKey(OBRAS_TENANT, OBRAS_EMPRESA, OBRAS_DAY);
    assert.ok(redis.keys().includes(envelopeKey));
  });

  it('reads the primary when Redis is down', async () => {
    const db = createObrasDb();
    const board = await getSiteBoard(obrasActor(db.client), OBRAS_SITE, OBRAS_DAY, new FakeRedis(true));
    assert.equal(board.siteId, OBRAS_SITE);
    assert.equal(db.boardSql(), 1);
  });
});
