// Crews listing coverage (`listCrews` in `../src/obras/crews.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the listing query over synthetic
// rows, applying the same subtree scope, `?orgNodeId=` / `?active=` filters,
// `(name ASC, id ASC)` order and `LIMIT` semantics as the real SQL. The suite
// pins the legacy bare array (alphabetical, cap 200), both filters, the 400
// on malformed input and the 403 on a caller with no membership. All data is
// synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listCrews,
  type CrewRecord,
  type ObraActorContext,
  type ObraClient,
} from '../src/obras/crews.service.ts';

const TENANT = 'a3000000-0000-4000-8000-0000000000c1';
const EMPRESA = 'b3000000-0000-4000-8000-0000000000c1';
const NODE_A = 'b3000000-0000-4000-8000-0000000000c2';
const NODE_B = 'b3000000-0000-4000-8000-0000000000c3';
const U_GERENTE = 'd3000000-0000-4000-8000-0000000000c1';
const M_GERENTE = 'e3000000-0000-4000-8000-0000000000c1';
const C1 = 'f3000000-0000-4000-8000-0000000000c1';
const C2 = 'f3000000-0000-4000-8000-0000000000c2';
const C3 = 'f3000000-0000-4000-8000-0000000000c3';
const TRACE = 'trace-crews-list';

type Row = Record<string, unknown>;

function crewRow(id: string, name: string, orgNodeId: string, active: boolean): Row {
  return { id, tenant_id: TENANT, org_node_id: orgNodeId, name, lead_membership_id: null, active };
}

interface FakeOptions {
  readonly withMembership?: boolean;
}

interface FakeDb {
  readonly client: ObraClient;
  readonly queries: string[];
}

function createDb(options: FakeOptions = {}): FakeDb {
  const queries: string[] = [];
  const withMembership = options.withMembership ?? true;
  const crews: Row[] = [
    crewRow(C1, 'Cuadrilla Acero', NODE_A, true),
    crewRow(C2, 'Cuadrilla Cemento', NODE_A, true),
    crewRow(C3, 'Cuadrilla Muros', NODE_B, false),
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
        if (!withMembership) return { rows: [] };
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
        return { rows: [{ id: EMPRESA }, { id: NODE_A }, { id: NODE_B }] };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'obras'] }] };
      }
      if (text.includes('FROM crews c')) {
        const scope = values[1] as string[];
        let rows = crews.filter((row) => scope.includes(String(row.org_node_id)));
        if (text.includes('c.org_node_id = $')) {
          const nodeParam = text.match(/c\.org_node_id = \$(\d+)::uuid/);
          if (nodeParam !== null) {
            const wanted = String(values[Number(nodeParam[1]) - 1]);
            rows = rows.filter((row) => String(row.org_node_id) === wanted);
          }
        }
        if (text.includes('c.active = $')) {
          const activeParam = text.match(/c\.active = \$(\d+)/);
          if (activeParam !== null) {
            const wanted = values[Number(activeParam[1]) - 1] as boolean;
            rows = rows.filter((row) => Boolean(row.active) === wanted);
          }
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

describe('listCrews legacy listing', () => {
  it('returns the scoped crews as a bare array in name order', async () => {
    const db = createDb();
    const rows: CrewRecord[] = await listCrews(actor(db), {});
    assert.deepEqual(
      rows.map((row) => row.name),
      ['Cuadrilla Acero', 'Cuadrilla Cemento', 'Cuadrilla Muros'],
    );
    assert.deepEqual(Object.keys(rows[0] as Record<string, unknown>).sort(), [
      'active',
      'id',
      'name',
      'orgNodeId',
    ]);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 200')),
      `expected the legacy cap, saw: ${db.queries.join(' | ')}`,
    );
  });

  it('filters by org node and by activation flag', async () => {
    const db = createDb();
    const byNode = await listCrews(actor(db), { orgNodeId: NODE_B });
    assert.deepEqual(
      byNode.map((row) => row.id),
      [C3],
    );
    const active = await listCrews(actor(db), { active: 'true' });
    assert.deepEqual(
      active.map((row) => row.id),
      [C1, C2],
    );
    const inactive = await listCrews(actor(db), { active: false });
    assert.deepEqual(
      inactive.map((row) => row.id),
      [C3],
    );
  });

  it('rejects a malformed filter with a 400', async () => {
    const db = createDb();
    for (const query of [{ orgNodeId: 'not-a-uuid' }, { active: 'maybe' }]) {
      await assert.rejects(listCrews(actor(db), query), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('denies a caller with no membership with a 403', async () => {
    const db = createDb({ withMembership: false });
    await assert.rejects(listCrews(actor(db), {}), (error: unknown) => {
      assert.equal(httpStatus(error), 403);
      return true;
    });
  });
});
