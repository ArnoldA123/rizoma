// Keyset pagination coverage for the cash-session listing
// (`listCashSessions` in `../src/billing/billing.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the listing query over synthetic
// rows, applying the same scope, filters, keyset predicate,
// `(opened_at DESC, id DESC)` order and `LIMIT` semantics as the real SQL.
// The suite walks a 3-row listing with `limit 2` through the chained
// `nextCursor`, proves a status filter ANDs with the cursor, and pins the 400
// on a malformed cursor plus the 500→200 clamp. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_ERROR,
  listCashSessions,
  type ActorContext,
  type BillingPage,
  type CashSessionRecord,
  type SaludClient,
} from '../src/billing/billing.service.ts';

const TENANT = 'a5000000-0000-4000-8000-0000000000c2';
const SEDE = 'b5000000-0000-4000-8000-0000000000c1';
const CAJERO = 'c5000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = 'd5000000-0000-4000-8000-0000000000c1';
const S1 = 'e5000000-0000-4000-8000-000000000011';
const S2 = 'e5000000-0000-4000-8000-000000000012';
const S3 = 'e5000000-0000-4000-8000-000000000013';
const TRACE = 'trace-cash-sessions-pagination';

type Row = Record<string, unknown>;

function sessionRow(id: string, openedAt: string, status: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: SEDE,
    opened_by: CAJERO,
    opened_at: openedAt,
    closed_at: status === 'closed' ? '2026-03-10T18:00:00.000Z' : null,
    totals: {},
    status,
  };
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const sessions: Row[] = [
    sessionRow(S1, '2026-03-10T09:00:00.000Z', 'open'),
    sessionRow(S2, '2026-03-09T09:00:00.000Z', 'open'),
    sessionRow(S3, '2026-03-08T09:00:00.000Z', 'closed'),
  ];

  function limitOf(text: string): number {
    const match = text.match(/LIMIT (\d+)\s*$/);
    return match === null ? 200 : Number(match[1]);
  }

  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push(text);
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: MEMBERSHIP,
              user_id: CAJERO,
              tenant_id: TENANT,
              org_node_id: SEDE,
              role: 'caja',
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
        return { rows: [{ modules: ['crm-core', 'salud'] }] };
      }
      if (text.includes('FROM cash_sessions c LEFT JOIN users')) {
        const scope = values[1] as string[];
        let rows = sessions.filter((row) => scope.includes(String(row.org_node_id)));
        if (text.includes('c.status = $')) {
          const status = String(values[2]);
          rows = rows.filter((row) => String(row.status) === status);
        }
        if (text.includes('(c.opened_at < $')) {
          const cursorOpenedAt = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.opened_at) < cursorOpenedAt ||
              (String(row.opened_at) === cursorOpenedAt && String(row.id) < cursorId),
          );
        }
        rows = [...rows].sort((left, right) => {
          const byDate = String(right.opened_at).localeCompare(String(left.opened_at));
          return byDate !== 0 ? byDate : String(right.id).localeCompare(String(left.id));
        });
        return {
          rows: rows.slice(0, limitOf(text)).map((row) => ({ ...row, opened_by_name: 'Caja Uno' })),
        };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(db: FakeDb): ActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: CAJERO,
    roles: [],
    traceId: TRACE,
    ip: null,
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

/** Narrows the list union onto the paged envelope (limit requests must page). */
function asPage(value: CashSessionRecord[] | BillingPage<CashSessionRecord>): BillingPage<CashSessionRecord> {
  assert.ok(!Array.isArray(value), 'a limit request must answer the paged envelope');
  return value;
}

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listCashSessions keyset walk', () => {
  it('chains limit 2 over 3 rows without overlap or gaps', async () => {
    const db = createDb();
    const first = asPage(await listCashSessions(actor(db), { limit: '2' }));
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [S1, S2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');
    for (const row of first.rows) assert.equal(row.openedByName, 'Caja Uno');

    const second = asPage(await listCashSessions(actor(db), { limit: '2', cursor: first.nextCursor }));
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [S3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('combines the status filter with the cursor inside the filtered walk', async () => {
    const db = createDb();
    const first = asPage(await listCashSessions(actor(db), { limit: '1', status: 'open' }));
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [S1],
    );
    assert.ok(first.nextCursor !== null);

    const second = asPage(
      await listCashSessions(actor(db), { limit: '1', status: 'open', cursor: first.nextCursor }),
    );
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [S2],
    );
    assert.equal(second.nextCursor, null);
    for (const page of [first, second]) {
      for (const row of page.rows) assert.equal(row.status, 'open');
    }
  });

  it('rejects a malformed cursor with a 400 billing.invalid_param', async () => {
    const db = createDb();
    for (const cursor of ['no-es-base64!!!', cursorWithoutOrderingKey()]) {
      try {
        await listCashSessions(actor(db), { cursor });
      } catch (error) {
        const http = httpError(error);
        assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
        assert.equal(http?.status, 400);
        assert.equal(http?.body.code, BILLING_ERROR.invalidParam);
        continue;
      }
      throw new Error('expected the call to fail with billing.invalid_param');
    }
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = asPage(await listCashSessions(actor(db), { limit: '500' }));
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
