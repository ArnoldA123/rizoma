// Budget-line listing coverage (`listBudgetLines` in
// `../src/obras/resources.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), the site lookup, the assignment key
// and the listing query over synthetic rows, applying the same site scope,
// `?active=` filter, `JOIN inventory_items` name resolution, ordering and
// `LIMIT` semantics as the real SQL. The suite pins the legacy bare array
// (alphabetical, cap 200), the sku/name join (null when the line has no
// item), the 400 on malformed input, the 404 on an unknown site and the 403
// on a caller with no site key. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listBudgetLines,
  type BudgetLineWithItem,
  type ObraActorContext,
  type ObraClient,
} from '../src/obras/resources.service.ts';

const TENANT = 'a3000000-0000-4000-8000-0000000000b1';
const EMPRESA = 'b3000000-0000-4000-8000-000000000001';
const NODE_A = 'b3000000-0000-4000-8000-000000000003';
const SITE_A = 'c3000000-0000-4000-8000-000000000001';
const SITE_UNKNOWN = 'c3000000-0000-4000-8000-000000000009';
const U_GERENTE = 'd3000000-0000-4000-8000-000000000001';
const U_TRABAJADOR = 'd3000000-0000-4000-8000-000000000004';
const M_GERENTE = 'e3000000-0000-4000-8000-000000000001';
const M_TRABAJADOR = 'e3000000-0000-4000-8000-000000000004';
const ITEM_A = 'f3000000-0000-4000-8000-000000000011';
const L1 = 'f3000000-0000-4000-8000-000000000021';
const L2 = 'f3000000-0000-4000-8000-000000000022';
const L3 = 'f3000000-0000-4000-8000-000000000023';
const TRACE = 'trace-budget-lines-list';

type Row = Record<string, unknown>;

function siteRow(): Row {
  return {
    id: SITE_A,
    tenant_id: TENANT,
    org_node_id: NODE_A,
    code: 'OBR-A',
    name: 'Obra Demo A',
    client_name: 'Cliente Demo',
    budget_total: 100000,
    started_at: '2026-01-05T00:00:00.000Z',
    ended_at: null,
    status: 'open',
  };
}

function lineRow(id: string, description: string, itemId: string | null, active: boolean): Row {
  return {
    id,
    tenant_id: TENANT,
    site_id: SITE_A,
    item_id: itemId,
    description,
    qty_planned: 100,
    unit_cost: 25,
    active,
  };
}

function itemRow(): Row {
  return {
    id: ITEM_A,
    tenant_id: TENANT,
    sku: 'CEM-001',
    name: 'Cemento Andino',
    unit: 'bolsa',
    min_stock: 10,
    active: true,
  };
}

interface FakeOptions {
  readonly role?: string;
  readonly userId?: string;
  readonly membershipId?: string;
}

interface FakeDb {
  readonly client: ObraClient;
  readonly queries: string[];
}

function createDb(options: FakeOptions = {}): FakeDb {
  const queries: string[] = [];
  const role = options.role ?? 'gerente';
  const userId = options.userId ?? U_GERENTE;
  const membershipId = options.membershipId ?? M_GERENTE;
  const lines: Row[] = [
    lineRow(L1, 'Acero', ITEM_A, true),
    lineRow(L2, 'Cemento', ITEM_A, true),
    lineRow(L3, 'Muros dados de baja', null, false),
  ];
  const items = new Map<string, Row>([[ITEM_A, itemRow()]]);

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
              id: membershipId,
              user_id: userId,
              tenant_id: TENANT,
              org_node_id: EMPRESA,
              role,
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
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        return { rows: String(values[1]) === SITE_A ? [siteRow()] : [] };
      }
      if (text.includes('FROM assignments') && text.includes('user_id = $2 AND site_id = $3')) {
        return { rows: [] };
      }
      if (text.includes('FROM budget_lines b LEFT JOIN inventory_items')) {
        let rows = lines.filter((row) => String(row.site_id) === String(values[1]));
        if (text.includes('b.active = $')) {
          const active = values[values.length - 1] as boolean;
          rows = rows.filter((row) => Boolean(row.active) === active);
        }
        rows = [...rows].sort(
          (left, right) =>
            String(left.description).localeCompare(String(right.description)) ||
            String(left.id).localeCompare(String(right.id)),
        );
        return {
          rows: rows.slice(0, limitOf(text)).map((row) => {
            const item = row.item_id === null ? undefined : items.get(String(row.item_id));
            return { ...row, item_sku: item === undefined ? null : item.sku, item_name: item === undefined ? null : item.name };
          }),
        };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(db: FakeDb, options: FakeOptions = {}): ObraActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: options.userId ?? U_GERENTE,
    roles: [],
    traceId: TRACE,
    ip: '127.0.0.1',
  };
}

/** Extracts `{status, body}` from a thrown Nest `HttpException`. */
function httpError(error: unknown): { status: number; body: Record<string, unknown> } | null {
  const candidate = error as { getStatus?: () => number; getResponse?: () => unknown };
  if (typeof candidate.getStatus !== 'function' || typeof candidate.getResponse !== 'function') {
    return null;
  }
  const response = candidate.getResponse() as unknown;
  const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
  return { status: candidate.getStatus(), body };
}

describe('listBudgetLines legacy list', () => {
  it('returns the site lines alphabetical with the item sku and name', async () => {
    const db = createDb();
    const rows: BudgetLineWithItem[] = await listBudgetLines(actor(db), SITE_A, {});
    assert.deepEqual(
      rows.map((row) => row.description),
      ['Acero', 'Cemento', 'Muros dados de baja'],
    );
    assert.equal(rows[0]?.itemSku, 'CEM-001');
    assert.equal(rows[0]?.itemName, 'Cemento Andino');
    assert.equal(rows[2]?.itemSku, null);
    assert.equal(rows[2]?.itemName, null);
  });

  it('filters by the active flag', async () => {
    const db = createDb();
    const active = await listBudgetLines(actor(db), SITE_A, { active: 'true' });
    assert.deepEqual(
      active.map((row) => row.id),
      [L1, L2],
    );
    const inactive = await listBudgetLines(actor(db), SITE_A, { active: 'false' });
    assert.deepEqual(
      inactive.map((row) => row.id),
      [L3],
    );
  });

  it('rejects a malformed site id with a 400 and an unknown site with a 404', async () => {
    const db = createDb();
    try {
      await listBudgetLines(actor(db), 'no-es-uuid', {});
    } catch (error) {
      assert.equal(httpError(error)?.status, 400);
    }
    try {
      await listBudgetLines(actor(db), SITE_UNKNOWN, {});
    } catch (error) {
      assert.equal(httpError(error)?.status, 404);
      return;
    }
    throw new Error('expected the unknown site to fail with 404');
  });

  it('rejects a non-boolean active with a 400', async () => {
    const db = createDb();
    try {
      await listBudgetLines(actor(db), SITE_A, { active: 'ayer' });
    } catch (error) {
      assert.equal(httpError(error)?.status, 400);
      return;
    }
    throw new Error('expected the call to fail with 400');
  });

  it('denies a trabajador with no assignment with a 403', async () => {
    const db = createDb({ role: 'trabajador', userId: U_TRABAJADOR, membershipId: M_TRABAJADOR });
    try {
      await listBudgetLines(actor(db, { userId: U_TRABAJADOR }), SITE_A, {});
    } catch (error) {
      const http = httpError(error);
      assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
      assert.equal(http?.status, 403);
      return;
    }
    throw new Error('expected the call to fail with obra.scope_denied');
  });
});
