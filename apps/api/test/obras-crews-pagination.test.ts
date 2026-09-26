// Keyset pagination coverage for the crews listing (`listCrewsPage` in
// `../src/obras/crews.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the listing query over synthetic
// rows, applying the same subtree scope, keyset predicate, `(name ASC, id
// ASC)` order and `LIMIT` semantics as the real SQL. The suite walks a 3-row
// listing with `limit 2` through the chained `nextCursor` and pins the 400 on
// a malformed cursor plus the 500→200 clamp. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listCrewsPage,
  type CrewPage,
  type CrewRecord,
  type ObraActorContext,
  type ObraClient,
} from '../src/obras/crews.service.ts';

const TENANT = 'a3000000-0000-4000-8000-0000000000c2';
const EMPRESA = 'b3000000-0000-4000-8000-0000000000c4';
const NODE_A = 'b3000000-0000-4000-8000-0000000000c5';
const U_GERENTE = 'd3000000-0000-4000-8000-0000000000c2';
const M_GERENTE = 'e3000000-0000-4000-8000-0000000000c2';
const C1 = 'f3000000-0000-4000-8000-0000000000c4';
const C2 = 'f3000000-0000-4000-8000-0000000000c5';
const C3 = 'f3000000-0000-4000-8000-0000000000c6';
const TRACE = 'trace-crews-pagination';

type Row = Record<string, unknown>;

function crewRow(id: string, name: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: NODE_A,
    name,
    lead_membership_id: null,
    active: true,
  };
}

interface FakeDb {
  readonly client: ObraClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const crews: Row[] = [
    crewRow(C1, 'Cuadrilla Acero'),
    crewRow(C2, 'Cuadrilla Cemento'),
    crewRow(C3, 'Cuadrilla Muros'),
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
              id: M_GERENTE,
              user_id: U_GERENTE,
              tenant_id: TENANT,
              org_node_id: EMPRESA,
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
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: [{ id: EMPRESA }, { id: NODE_A }] };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'obras'] }] };
      }
      if (text.includes('FROM crews c')) {
        const scope = values[1] as string[];
        let rows = crews.filter((row) => scope.includes(String(row.org_node_id)));
        if (text.includes('(c.name > $')) {
          const cursorName = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.name) > cursorName ||
              (String(row.name) === cursorName && String(row.id) > cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(left.name).localeCompare(String(right.name)) ||
            String(left.id).localeCompare(String(right.id)),
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
    userId: U_GERENTE,
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

describe('listCrewsPage keyset walk', () => {
  it('chains limit 2 over 3 rows without overlap or gaps', async () => {
    const db = createDb();
    const first: CrewPage<CrewRecord> = await listCrewsPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [C1, C2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second: CrewPage<CrewRecord> = await listCrewsPage(actor(db), {
      limit: '2',
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [C3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    for (const cursor of ['no-es-base64!!!', cursorWithoutOrderingKey()]) {
      await assert.rejects(listCrewsPage(actor(db), { cursor }), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listCrewsPage(actor(db), { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
