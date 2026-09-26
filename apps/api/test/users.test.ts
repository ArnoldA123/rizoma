// Personnel listing coverage (`listUsers` in `../src/users/users.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the `users` + `memberships` join
// over synthetic rows, applying the same scope, active-membership rule,
// filters, ordering and `LIMIT` semantics as the real SQL. The suite pins the
// subtree scope, the three filters, the PII allowlist (no `phone` /
// `mfa_enrolled` in the SQL or the rows), the 400 on malformed filters and
// the 403 on a role with no read grant. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listUsers,
  type UserActorContext,
  type UserClient,
} from '../src/users/users.service.ts';

const TENANT = 'a8000000-0000-4000-8000-0000000000a1';
const SEDE_A = 'b8000000-0000-4000-8000-000000000001';
const SEDE_B = 'b8000000-0000-4000-8000-000000000002';
const OUTSIDE = 'b8000000-0000-4000-8000-000000000003';
const CALLER = 'c8000000-0000-4000-8000-000000000001';
const U1 = 'c8000000-0000-4000-8000-000000000011';
const U2 = 'c8000000-0000-4000-8000-000000000012';
const U3 = 'c8000000-0000-4000-8000-000000000013';
const U_OUT = 'c8000000-0000-4000-8000-000000000014';
const U_IDLE = 'c8000000-0000-4000-8000-000000000015';
const MEMBERSHIP = 'd8000000-0000-4000-8000-000000000001';
const TRACE = 'trace-users-list';

type Row = Record<string, unknown>;

function userRow(id: string, name: string, createdAt: string, active: boolean): Row {
  return {
    id,
    tenant_id: TENANT,
    name,
    email: `${name.toLowerCase().replace(/ /g, '.')}@demo.test`,
    phone: '+51999999999',
    active,
    mfa_enrolled: true,
    created_at: createdAt,
  };
}

function membershipRow(userId: string, orgNodeId: string, role: string, active: boolean): Row {
  return { user_id: userId, tenant_id: TENANT, org_node_id: orgNodeId, role, active };
}

const USERS: Row[] = [
  userRow(U1, 'Ana Medico', '2026-03-03T10:00:00.000Z', true),
  userRow(U2, 'Luis Recepcion', '2026-03-02T10:00:00.000Z', true),
  userRow(U3, 'Marta Baja', '2026-03-01T10:00:00.000Z', false),
  userRow(U_OUT, 'Pedro Fuera', '2026-03-04T10:00:00.000Z', true),
  userRow(U_IDLE, 'Rosa Inactiva', '2026-02-01T10:00:00.000Z', true),
];

const MEMBERSHIPS: Row[] = [
  membershipRow(U1, SEDE_A, 'medico', true),
  membershipRow(U2, SEDE_A, 'recepcion', true),
  membershipRow(U3, SEDE_A, 'recepcion', true),
  membershipRow(U_OUT, OUTSIDE, 'medico', true),
  membershipRow(U_IDLE, SEDE_A, 'recepcion', false),
];

interface FakeOptions {
  readonly role?: string;
  readonly modules?: string[];
}

interface FakeDb {
  readonly client: UserClient;
  readonly queries: string[];
}

function createDb(options: FakeOptions = {}): FakeDb {
  const queries: string[] = [];
  const role = options.role ?? 'gerente';
  const modules = options.modules ?? ['crm-core', 'obras'];

  function limitOf(text: string): number {
    const match = text.match(/LIMIT (\d+)\s*$/);
    return match === null ? 200 : Number(match[1]);
  }

  const client: UserClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push(text);
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: MEMBERSHIP,
              user_id: CALLER,
              tenant_id: TENANT,
              org_node_id: SEDE_A,
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
        return { rows: [{ id: SEDE_A }, { id: SEDE_B }] };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules }] };
      }
      if (text.includes('JOIN memberships')) {
        const scope = values[1] as string[];
        let joined = MEMBERSHIPS.filter(
          (membership) =>
            membership.active === true && scope.includes(String(membership.org_node_id)),
        ).map((membership) => {
          const user = USERS.find((candidate) => candidate.id === membership.user_id);
          return { ...user, org_node_id: membership.org_node_id, role: membership.role };
        });
        for (const match of text.matchAll(/(m\.org_node_id|m\.role|u\.active) = \$(\d+)/g)) {
          const column = match[1];
          const value = values[Number(match[2]) - 1];
          if (column === 'm.org_node_id') {
            joined = joined.filter((row) => String(row.org_node_id) === String(value));
          }
          if (column === 'm.role') joined = joined.filter((row) => String(row.role) === String(value));
          if (column === 'u.active') {
            joined = joined.filter((row) => Boolean(row.active) === Boolean(value));
          }
        }
        if (text.includes('(u.created_at < $')) {
          const cursorCreatedAt = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          joined = joined.filter(
            (row) =>
              String(row.created_at) < cursorCreatedAt ||
              (String(row.created_at) === cursorCreatedAt && String(row.id) < cursorId),
          );
        }
        joined = [...joined].sort(
          (left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) ||
            String(right.id).localeCompare(String(left.id)),
        );
        return { rows: joined.slice(0, limitOf(text)) };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(db: FakeDb): UserActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: CALLER,
    roles: [],
    traceId: TRACE,
    ip: '127.0.0.1',
  };
}

function httpStatus(error: unknown): number | null {
  const candidate = error as { getStatus?: () => number };
  return typeof candidate.getStatus === 'function' ? candidate.getStatus() : null;
}

describe('listUsers', () => {
  it('lists active memberships in the subtree newest-first with the PII-safe shape', async () => {
    const db = createDb();
    const rows = await listUsers(actor(db), {});
    assert.deepEqual(
      rows.map((row) => row.id),
      [U1, U2, U3],
    );
    assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
      'active',
      'email',
      'id',
      'name',
      'orgNodeId',
      'role',
    ]);
    assert.equal(rows[0]?.orgNodeId, SEDE_A);
    assert.equal(rows[0]?.role, 'medico');
    for (const row of rows) {
      assert.ok(!('phone' in row), 'phone must never leak');
      assert.ok(!('mfa_enrolled' in row), 'mfa_enrolled must never leak');
    }
  });

  it('never selects phone or mfa_enrolled in its SQL', async () => {
    const db = createDb();
    await listUsers(actor(db), {});
    const listing = db.queries.filter((text) => text.includes('JOIN memberships'));
    assert.ok(listing.length > 0, 'expected the join query to run');
    for (const text of listing) {
      assert.ok(!text.includes('phone'), `PII leak in SQL: ${text}`);
      assert.ok(!text.includes('mfa_enrolled'), `PII leak in SQL: ${text}`);
    }
  });

  it('excludes out-of-scope nodes and inactive memberships', async () => {
    const db = createDb();
    const rows = await listUsers(actor(db), {});
    assert.ok(!rows.some((row) => row.id === U_OUT), 'outside the subtree must stay invisible');
    assert.ok(!rows.some((row) => row.id === U_IDLE), 'inactive memberships must stay hidden');
  });

  it('filters by orgNodeId, role and active', async () => {
    const db = createDb();
    assert.deepEqual(
      (await listUsers(actor(db), { role: 'recepcion' })).map((row) => row.id),
      [U2, U3],
    );
    assert.deepEqual(
      (await listUsers(actor(db), { orgNodeId: SEDE_B })).map((row) => row.id),
      [],
    );
    assert.deepEqual(
      (await listUsers(actor(db), { active: 'false' })).map((row) => row.id),
      [U3],
    );
  });

  it('lets a salud reader through the same transversal gate', async () => {
    const db = createDb({ role: 'medico', modules: ['crm-core', 'salud'] });
    const rows = await listUsers(actor(db), {});
    assert.equal(rows.length, 3);
  });

  it('rejects malformed filters with a 400', async () => {
    const db = createDb();
    for (const query of [
      { orgNodeId: 'no-es-uuid' },
      { role: 'superadmin' },
      { active: 'quizas' },
    ]) {
      await assert.rejects(listUsers(actor(db), query), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('denies a role with no read grant with a 403 and audits the denial', async () => {
    const db = createDb({ role: 'soporte' });
    await assert.rejects(listUsers(actor(db), {}), (error: unknown) => {
      assert.equal(httpStatus(error), 403);
      return true;
    });
    assert.ok(db.queries.some((text) => text.includes('INSERT INTO audit_log')));
  });
});
