// Org node listing coverage (`listOrgNodes` in `../src/org/org.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the listing query over synthetic
// rows, applying the same scope, filters, ordering and `LIMIT` semantics as
// the real SQL. The suite pins the subtree scope (no tenant-global read), the
// three filters, the 400 on malformed filters and the 403 on a role with no
// read grant. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listOrgNodes,
  type OrgActorContext,
  type OrgClient,
} from '../src/org/org.service.ts';

const TENANT = 'a7000000-0000-4000-8000-0000000000a1';
const ROOT = 'b7000000-0000-4000-8000-000000000001';
const SEDE_LIMA = 'b7000000-0000-4000-8000-000000000002';
const SEDE_AREQUIPA = 'b7000000-0000-4000-8000-000000000003';
const AREA_LIMA = 'b7000000-0000-4000-8000-000000000004';
const USER = 'c7000000-0000-4000-8000-000000000001';
const MEMBERSHIP = 'd7000000-0000-4000-8000-000000000001';
const TRACE = 'trace-org-list';

type Row = Record<string, unknown>;

function nodeRow(
  id: string,
  parentId: string | null,
  kind: string,
  name: string,
  active: boolean,
): Row {
  return { id, tenant_id: TENANT, parent_id: parentId, kind, name, active };
}

const NODES: Row[] = [
  nodeRow(ROOT, null, 'empresa', 'Demo Company', true),
  nodeRow(SEDE_LIMA, ROOT, 'sede', 'Sede Arequipa', true),
  nodeRow(SEDE_AREQUIPA, ROOT, 'sede', 'Sede Lima', true),
  nodeRow(AREA_LIMA, SEDE_LIMA, 'area', 'Almacen Lima', true),
  nodeRow('b7000000-0000-4000-8000-000000000005', ROOT, 'sede', 'Sede Cerrada', false),
];

interface FakeOptions {
  readonly role?: string;
  readonly membershipNode?: string;
  readonly modules?: string[];
}

interface FakeDb {
  readonly client: OrgClient;
  readonly queries: string[];
}

function createDb(options: FakeOptions = {}): FakeDb {
  const queries: string[] = [];
  const role = options.role ?? 'recepcion';
  const membershipNode = options.membershipNode ?? ROOT;
  const modules = options.modules ?? ['crm-core', 'salud'];
  const subtree =
    membershipNode === ROOT ? NODES.map((row) => String(row.id)) : [SEDE_LIMA, AREA_LIMA];

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
              org_node_id: membershipNode,
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
        return { rows: subtree.map((id) => ({ id })) };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules }] };
      }
      if (text.includes('FROM org_nodes WHERE tenant_id = $1 AND id = ANY')) {
        const scope = values[1] as string[];
        let rows = NODES.filter((row) => scope.includes(String(row.id)));
        for (const match of text.matchAll(/(\w+) = \$(\d+)/g)) {
          const column = match[1];
          const value = values[Number(match[2]) - 1];
          if (column === 'kind') rows = rows.filter((row) => String(row.kind) === String(value));
          if (column === 'active') rows = rows.filter((row) => Boolean(row.active) === Boolean(value));
          if (column === 'parent_id') {
            rows = rows.filter((row) => String(row.parent_id) === String(value));
          }
        }
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

describe('listOrgNodes', () => {
  it('lists the subtree alphabetical with the selector shape', async () => {
    const db = createDb();
    const rows = await listOrgNodes(actor(db), {});
    assert.deepEqual(
      rows.map((row) => row.name),
      ['Almacen Lima', 'Demo Company', 'Sede Arequipa', 'Sede Cerrada', 'Sede Lima'],
    );
    assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), ['active', 'id', 'kind', 'name', 'parentId', 'timezone']);
    const root = rows.find((row) => row.id === ROOT);
    assert.equal(root?.parentId, null);
    const area = rows.find((row) => row.id === AREA_LIMA);
    assert.equal(area?.parentId, SEDE_LIMA);
    assert.equal(area?.kind, 'area');
  });

  it('bounds the listing to the membership subtree (no tenant-global read)', async () => {
    const db = createDb({ membershipNode: SEDE_LIMA });
    const rows = await listOrgNodes(actor(db), {});
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      [AREA_LIMA, SEDE_LIMA].sort(),
    );
  });

  it('filters by kind, active and parent', async () => {
    const db = createDb();
    assert.deepEqual(
      (await listOrgNodes(actor(db), { kind: 'sede' })).map((row) => row.name),
      ['Sede Arequipa', 'Sede Cerrada', 'Sede Lima'],
    );
    assert.deepEqual(
      (await listOrgNodes(actor(db), { active: 'false' })).map((row) => row.name),
      ['Sede Cerrada'],
    );
    assert.deepEqual(
      (await listOrgNodes(actor(db), { parent: SEDE_LIMA })).map((row) => row.name),
      ['Almacen Lima'],
    );
  });

  it('lets a construction role through the same transversal gate', async () => {
    const db = createDb({ role: 'trabajador' });
    const rows = await listOrgNodes(actor(db), {});
    assert.equal(rows.length, 5);
  });

  it('rejects malformed filters with a 400', async () => {
    const db = createDb();
    for (const query of [
      { kind: 'planta' },
      { active: 'quizas' },
      { parent: 'no-es-uuid' },
    ]) {
      await assert.rejects(listOrgNodes(actor(db), query), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('denies a role with no read grant with a 403 and audits the denial', async () => {
    const db = createDb({ role: 'vendedor' });
    await assert.rejects(listOrgNodes(actor(db), {}), (error: unknown) => {
      assert.equal(httpStatus(error), 403);
      return true;
    });
    assert.ok(db.queries.some((text) => text.includes('INSERT INTO audit_log')));
  });
});
