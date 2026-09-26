// Keyset pagination coverage for the budget-line listing
// (`listBudgetLinesPage` in `../src/obras/resources.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), the site lookup and the listing query
// over synthetic rows, applying the same site scope, `?active=` filter,
// keyset predicate, `(description ASC, id ASC)` order and `LIMIT` semantics
// as the real SQL. The suite walks a 3-row listing with `limit 2` through
// the chained `nextCursor` and pins the 400 on a malformed cursor plus the
// 500→200 clamp. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listBudgetLinesPage,
  type BudgetLineWithItem,
  type ObraActorContext,
  type ObraClient,
  type ResourcePage,
} from '../src/obras/resources.service.ts';

const TENANT = 'a3000000-0000-4000-8000-0000000000b2';
const EMPRESA = 'b3000000-0000-4000-8000-000000000011';
const NODE_A = 'b3000000-0000-4000-8000-000000000013';
const SITE_A = 'c3000000-0000-4000-8000-000000000011';
const U_GERENTE = 'd3000000-0000-4000-8000-000000000011';
const M_GERENTE = 'e3000000-0000-4000-8000-000000000011';
const ITEM_A = 'f3000000-0000-4000-8000-000000000111';
const L1 = 'f3000000-0000-4000-8000-000000000121';
const L2 = 'f3000000-0000-4000-8000-000000000122';
const L3 = 'f3000000-0000-4000-8000-000000000123';
const TRACE = 'trace-budget-lines-pagination';

type Row = Record<string, unknown>;

function lineRow(id: string, description: string): Row {
  return {
    id,
    tenant_id: TENANT,
    site_id: SITE_A,
    item_id: ITEM_A,
    description,
    qty_planned: 100,
    unit_cost: 25,
    active: true,
  };
}

interface FakeDb {
  readonly client: ObraClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const lines: Row[] = [lineRow(L1, 'Acero'), lineRow(L2, 'Cemento'), lineRow(L3, 'Muros')];

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
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        return {
          rows: [
            {
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
            },
          ],
        };
      }
      if (text.includes('FROM assignments') && text.includes('user_id = $2 AND site_id = $3')) {
        return { rows: [] };
      }
      if (text.includes('FROM budget_lines b LEFT JOIN inventory_items')) {
        let rows = lines.filter((row) => String(row.site_id) === String(values[1]));
        if (text.includes('(b.description > $')) {
          const cursorDescription = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.description) > cursorDescription ||
              (String(row.description) === cursorDescription && String(row.id) > cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(left.description).localeCompare(String(right.description)) ||
            String(left.id).localeCompare(String(right.id)),
        );
        return {
          rows: rows
            .slice(0, limitOf(text))
            .map((row) => ({ ...row, item_sku: 'CEM-001', item_name: 'Cemento Andino' })),
        };
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

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listBudgetLinesPage keyset walk', () => {
  it('chains limit 2 over 3 rows without overlap or gaps', async () => {
    const db = createDb();
    const first: ResourcePage<BudgetLineWithItem> = await listBudgetLinesPage(actor(db), SITE_A, {
      limit: '2',
    });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [L1, L2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');
    for (const row of first.rows) assert.equal(row.itemSku, 'CEM-001');

    const second: ResourcePage<BudgetLineWithItem> = await listBudgetLinesPage(actor(db), SITE_A, {
      limit: '2',
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [L3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    for (const cursor of ['no-es-base64!!!', cursorWithoutOrderingKey()]) {
      try {
        await listBudgetLinesPage(actor(db), SITE_A, { cursor });
      } catch (error) {
        const http = httpError(error);
        assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
        assert.equal(http?.status, 400);
        continue;
      }
      throw new Error('expected the call to fail with 400');
    }
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listBudgetLinesPage(actor(db), SITE_A, { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
