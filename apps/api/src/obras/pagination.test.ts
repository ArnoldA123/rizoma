// Keyset pagination coverage for the obras listings (`listSitesPage` in
// `obras.service.ts`, `listAssetsPage` / `listMovesPage` in
// `resources.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the three listing queries over
// synthetic rows, applying the same scope, keyset-predicate, ordering and
// `LIMIT` semantics as the real SQL. The suite walks each 3-row listing with
// `limit 2` through the chained `nextCursor`, and pins the 400 on a malformed
// cursor plus the 500→200 clamp on the site listing. The site/asset/move
// listings carry no `saved_view_id` wiring by design (their controllers
// forward only `?cursor=` / `?limit=`); the view-plus-cursor combination is
// covered by the salud and billing pagination suites. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listSitesPage,
  type ObraActorContext,
  type ObraClient,
} from './obras.service.ts';
import { listAssetsPage, listMovesPage } from './resources.service.ts';

const TENANT = 'a6000000-0000-4000-8000-0000000000a1';
const SEDE = 'b6000000-0000-4000-8000-000000000001';
const USER = 'c6000000-0000-4000-8000-000000000001';
const MEMBERSHIP = 'd6000000-0000-4000-8000-000000000001';
const S1 = 'e6000000-0000-4000-8000-000000000001';
const S2 = 'e6000000-0000-4000-8000-000000000002';
const S3 = 'e6000000-0000-4000-8000-000000000003';
const A1 = 'e6000000-0000-4000-8000-000000000011';
const A2 = 'e6000000-0000-4000-8000-000000000012';
const A3 = 'e6000000-0000-4000-8000-000000000013';
const M1 = 'e6000000-0000-4000-8000-000000000021';
const M2 = 'e6000000-0000-4000-8000-000000000022';
const M3 = 'e6000000-0000-4000-8000-000000000023';
const TRACE = 'trace-obras-pagination';

type Row = Record<string, unknown>;

function siteRow(id: string, code: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: SEDE,
    code,
    name: `Site ${code}`,
    client_name: 'Cliente Demo',
    budget_total: 1000,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    status: 'active',
  };
}

function assetRow(id: string, code: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: SEDE,
    code,
    kind: 'excavator',
    serial: `SN-${code}`,
    status: 'available',
    current_site_id: null,
  };
}

function moveRow(id: string, at: string): Row {
  return {
    id,
    tenant_id: TENANT,
    item_id: 'f6000000-0000-4000-8000-000000000031',
    warehouse_node_id: SEDE,
    site_id: S1,
    qty: 5,
    kind: 'in',
    at,
    status: 'posted',
  };
}

interface FakeDb {
  readonly client: ObraClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const sites: Row[] = [siteRow(S1, 'OBR-001'), siteRow(S2, 'OBR-002'), siteRow(S3, 'OBR-003')];
  const assets: Row[] = [assetRow(A1, 'EQ-001'), assetRow(A2, 'EQ-002'), assetRow(A3, 'EQ-003')];
  const moves: Row[] = [
    moveRow(M1, '2026-03-03T10:00:00.000Z'),
    moveRow(M2, '2026-03-02T10:00:00.000Z'),
    moveRow(M3, '2026-03-01T10:00:00.000Z'),
  ];

  function limitOf(text: string): number {
    const match = text.match(/LIMIT (\d+)\s*$/);
    return match === null ? 200 : Number(match[1]);
  }

  const client: ObraClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push(text);
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: MEMBERSHIP,
              user_id: USER,
              tenant_id: TENANT,
              org_node_id: SEDE,
              role: 'gerente',
              scopes: [],
              active: true,
              valid_from: '2020-01-01T00:00:00.000Z',
              valid_to: null,
              user_active: true,
            },
          ],
        };
      }
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE }] };
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'obras'] }] };
      }
      if (text.includes('FROM sites WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = values[1] as string[];
        let rows = sites.filter((row) => scope.includes(String(row.org_node_id)));
        if (text.includes('(code > $')) {
          const cursorCode = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) => String(row.code) > cursorCode || (String(row.code) === cursorCode && String(row.id) > cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(left.code).localeCompare(String(right.code)) ||
            String(left.id).localeCompare(String(right.id)),
        );
        return { rows: rows.slice(0, limitOf(text)) };
      }
      if (text.includes('FROM assets WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = values[1] as string[];
        let rows = assets.filter((row) => scope.includes(String(row.org_node_id)));
        if (text.includes('(code > $')) {
          const cursorCode = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) => String(row.code) > cursorCode || (String(row.code) === cursorCode && String(row.id) > cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(left.code).localeCompare(String(right.code)) ||
            String(left.id).localeCompare(String(right.id)),
        );
        return { rows: rows.slice(0, limitOf(text)) };
      }
      if (text.includes('FROM stock_moves WHERE tenant_id = $1 AND warehouse_node_id = ANY')) {
        const scope = values[1] as string[];
        let rows = moves.filter((row) => scope.includes(String(row.warehouse_node_id)));
        if (text.includes('(at < $')) {
          const cursorAt = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.at) < cursorAt || (String(row.at) === cursorAt && String(row.id) < cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(right.at).localeCompare(String(left.at)) ||
            String(right.id).localeCompare(String(left.id)),
        );
        return { rows: rows.slice(0, limitOf(text)) };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(db: FakeDb): ObraActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: USER,
    roles: [],
    traceId: TRACE,
    ip: '127.0.0.1',
  };
}

function httpStatus(error: unknown): number | null {
  const candidate = error as { getStatus?: () => number };
  return typeof candidate.getStatus === 'function' ? candidate.getStatus() : null;
}

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listSitesPage keyset walk', () => {
  it('chains limit 2 over 3 rows in code order without overlap or gaps', async () => {
    const db = createDb();
    const first = await listSitesPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.code),
      ['OBR-001', 'OBR-002'],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second = await listSitesPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.code),
      ['OBR-003'],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    await assert.rejects(
      listSitesPage(actor(db), { cursor: cursorWithoutOrderingKey() }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listSitesPage(actor(db), { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});

describe('listAssetsPage keyset walk', () => {
  it('chains limit 2 over 3 rows through the opaque cursor', async () => {
    const db = createDb();
    const first = await listAssetsPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.code),
      ['EQ-001', 'EQ-002'],
    );
    assert.ok(first.nextCursor !== null);

    const second = await listAssetsPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.code),
      ['EQ-003'],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    await assert.rejects(
      listAssetsPage(actor(db), { cursor: cursorWithoutOrderingKey() }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
  });
});

describe('listMovesPage keyset walk', () => {
  it('chains limit 2 over 3 rows newest-first through the opaque cursor', async () => {
    const db = createDb();
    const first = await listMovesPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [M1, M2],
    );
    assert.ok(first.nextCursor !== null);

    const second = await listMovesPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [M3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    await assert.rejects(
      listMovesPage(actor(db), { cursor: cursorWithoutOrderingKey() }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
  });
});
