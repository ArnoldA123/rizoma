// Keyset pagination coverage for the personnel listing (`listUsersPage` in
// `../src/users/users.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the `users` + `memberships` join
// over synthetic rows, applying the same scope, keyset-predicate,
// `(created_at DESC, id DESC)` order and `LIMIT` semantics as the real SQL.
// The suite walks a 3-row listing with `limit 2` through the chained
// `nextCursor`, and pins the 400 on a malformed cursor plus the 500→200 clamp.
// All data is synthetic and carries no PII beyond the contract fields.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listUsersPage,
  type UserActorContext,
  type UserClient,
} from '../src/users/users.service.ts';

const TENANT = 'a8000000-0000-4000-8000-0000000000b1';
const SEDE = 'b8000000-0000-4000-8000-000000000101';
const CALLER = 'c8000000-0000-4000-8000-000000000101';
const U1 = 'c8000000-0000-4000-8000-000000000111';
const U2 = 'c8000000-0000-4000-8000-000000000112';
const U3 = 'c8000000-0000-4000-8000-000000000113';
const MEMBERSHIP = 'd8000000-0000-4000-8000-000000000101';
const TRACE = 'trace-users-pagination';

type Row = Record<string, unknown>;

function joinedRow(id: string, createdAt: string): Row {
  return {
    id,
    tenant_id: TENANT,
    name: `Person ${id.slice(-3)}`,
    email: `person.${id.slice(-3)}@demo.test`,
    active: true,
    created_at: createdAt,
    org_node_id: SEDE,
    role: 'medico',
  };
}

interface FakeDb {
  readonly client: UserClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const joined: Row[] = [
    joinedRow(U1, '2026-03-03T10:00:00.000Z'),
    joinedRow(U2, '2026-03-02T10:00:00.000Z'),
    joinedRow(U3, '2026-03-01T10:00:00.000Z'),
  ];

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
      if (text.includes('JOIN memberships')) {
        let rows = [...joined];
        if (text.includes('(u.created_at < $')) {
          const cursorCreatedAt = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.created_at) < cursorCreatedAt ||
              (String(row.created_at) === cursorCreatedAt && String(row.id) < cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) ||
            String(right.id).localeCompare(String(left.id)),
        );
        return { rows: rows.slice(0, limitOf(text)) };
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

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listUsersPage keyset walk', () => {
  it('chains limit 2 over 3 rows newest-first without overlap or gaps', async () => {
    const db = createDb();
    const first = await listUsersPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [U1, U2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second = await listUsersPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [U3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    for (const cursor of [cursorWithoutOrderingKey(), 'not-a-cursor!!!']) {
      await assert.rejects(listUsersPage(actor(db), { cursor }), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listUsersPage(actor(db), { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
