// Keyset pagination coverage for the org listing (`listOrgNodesPage` in
// `../src/org/org.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the listing query over synthetic
// rows, applying the same scope, keyset-predicate, ordering and `LIMIT`
// semantics as the real SQL. The suite walks a 3-row listing with `limit 2`
// through the chained `nextCursor`, and pins the 400 on a malformed cursor
// plus the 500→200 clamp. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listOrgNodesPage,
  type OrgActorContext,
  type OrgClient,
} from '../src/org/org.service.ts';

const TENANT = 'a7000000-0000-4000-8000-0000000000b1';
const ROOT = 'b7000000-0000-4000-8000-000000000101';
const N1 = 'b7000000-0000-4000-8000-000000000102';
const N2 = 'b7000000-0000-4000-8000-000000000103';
const N3 = 'b7000000-0000-4000-8000-000000000104';
const USER = 'c7000000-0000-4000-8000-000000000101';
const MEMBERSHIP = 'd7000000-0000-4000-8000-000000000101';
const TRACE = 'trace-org-pagination';

type Row = Record<string, unknown>;

function nodeRow(id: string, name: string): Row {
  return { id, tenant_id: TENANT, parent_id: ROOT, kind: 'sede', name, active: true };
}

interface FakeDb {
  readonly client: OrgClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const nodes: Row[] = [
    nodeRow(N1, 'Sede Arequipa'),
    nodeRow(N2, 'Sede Cusco'),
    nodeRow(N3, 'Sede Lima'),
  ];

  function limitOf(text: string): number {
    const match = text.match(/LIMIT (\d+)\s*$/);
    return match === null ? 200 : Number(match[1]);
  }

  const client: OrgClient = {
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
              org_node_id: ROOT,
              role: 'recepcion',
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
        return { rows: [ROOT, N1, N2, N3].map((id) => ({ id })) };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'salud'] }] };
      }
      if (text.includes('FROM org_nodes WHERE tenant_id = $1 AND id = ANY')) {
        const scope = values[1] as string[];
        let rows = nodes.filter((row) => scope.includes(String(row.id)));
        if (text.includes('(name > $')) {
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

function actor(db: FakeDb): OrgActorContext {
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

describe('listOrgNodesPage keyset walk', () => {
  it('chains limit 2 over 3 rows in name order without overlap or gaps', async () => {
    const db = createDb();
    const first = await listOrgNodesPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.name),
      ['Sede Arequipa', 'Sede Cusco'],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second = await listOrgNodesPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.name),
      ['Sede Lima'],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    for (const cursor of [cursorWithoutOrderingKey(), 'not-a-cursor!!!']) {
      await assert.rejects(listOrgNodesPage(actor(db), { cursor }), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listOrgNodesPage(actor(db), { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
