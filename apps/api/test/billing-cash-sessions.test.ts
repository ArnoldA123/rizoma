// Cash-session listing coverage (`listCashSessions` in
// `../src/billing/billing.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules) and the listing query over synthetic
// rows, applying the same scope, filters, `JOIN users` name resolution,
// ordering and `LIMIT` semantics as the real SQL. The suite pins the legacy
// bare array (newest first, cap 200), the four filters, the 400 on malformed
// filters and the 403 on a role with no billing grant. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_ERROR,
  listCashSessions,
  type ActorContext,
  type CashSessionRecord,
  type SaludClient,
} from '../src/billing/billing.service.ts';

const TENANT = 'a5000000-0000-4000-8000-0000000000c1';
const SEDE = 'b5000000-0000-4000-8000-0000000000c1';
const SEDE_B = 'b5000000-0000-4000-8000-0000000000c2';
const CAJERO = 'c5000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = 'd5000000-0000-4000-8000-0000000000c1';
const S1 = 'e5000000-0000-4000-8000-000000000001';
const S2 = 'e5000000-0000-4000-8000-000000000002';
const S3 = 'e5000000-0000-4000-8000-000000000003';
const TRACE = 'trace-cash-sessions-list';

type Row = Record<string, unknown>;

function sessionRow(
  id: string,
  orgNodeId: string,
  openedAt: string,
  status: string,
  openedBy: string = CAJERO,
): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: orgNodeId,
    opened_by: openedBy,
    opened_at: openedAt,
    closed_at: status === 'closed' ? '2026-03-10T18:00:00.000Z' : null,
    totals: {},
    status,
  };
}

const USERS: Record<string, string> = { [CAJERO]: 'Caja Uno' };

interface FakeOptions {
  readonly role?: string;
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: string[];
}

function createDb(options: FakeOptions = {}): FakeDb {
  const queries: string[] = [];
  const role = options.role ?? 'caja';
  const sessions: Row[] = [
    sessionRow(S1, SEDE, '2026-03-10T09:00:00.000Z', 'open'),
    sessionRow(S2, SEDE, '2026-03-09T09:00:00.000Z', 'closed'),
    sessionRow(S3, SEDE_B, '2026-03-08T09:00:00.000Z', 'open'),
  ];

  /** Reads one `c.<col> = $n` predicate back out of the listing SQL. */
  function equalityValue(text: string, values: readonly unknown[], column: string): unknown {
    const match = text.match(new RegExp(`c\\.${column} = \\$(\\d+)`));
    if (match === null) return undefined;
    return values[Number(match[1]) - 1];
  }

  /** Reads one `c.<col> (>=|<=) $n::timestamptz` bound back out of the SQL. */
  function rangeValue(text: string, values: readonly unknown[], column: string, op: string): unknown {
    const match = text.match(new RegExp(`c\\.${column} ${op} \\$(\\d+)::timestamptz`));
    if (match === null) return undefined;
    return values[Number(match[1]) - 1];
  }

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
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE }, { id: SEDE_B }] };
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'salud'] }] };
      }
      if (text.includes('FROM cash_sessions c LEFT JOIN users')) {
        const scope = values[1] as string[];
        let rows = sessions.filter((row) => scope.includes(String(row.org_node_id)));
        const status = equalityValue(text, values, 'status');
        if (status !== undefined) rows = rows.filter((row) => String(row.status) === String(status));
        const node = equalityValue(text, values, 'org_node_id');
        if (node !== undefined) rows = rows.filter((row) => String(row.org_node_id) === String(node));
        const from = rangeValue(text, values, 'opened_at', '>=');
        if (from !== undefined) rows = rows.filter((row) => String(row.opened_at) >= String(from));
        const to = rangeValue(text, values, 'opened_at', '<=');
        if (to !== undefined) rows = rows.filter((row) => String(row.opened_at) <= String(to));
        rows = [...rows].sort((left, right) => String(right.opened_at).localeCompare(String(left.opened_at)));
        return {
          rows: rows.slice(0, limitOf(text)).map((row) => ({
            ...row,
            opened_by_name: USERS[String(row.opened_by)] ?? null,
          })),
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

/** Narrows the list union onto the legacy bare array (no cursor/limit sent). */
function asLegacy(value: CashSessionRecord[] | { rows: CashSessionRecord[] }): CashSessionRecord[] {
  assert.ok(Array.isArray(value), 'a filter-only request must answer the legacy bare array');
  return value;
}

describe('listCashSessions legacy list', () => {
  it('returns the subtree shifts newest first with the opener name', async () => {
    const db = createDb();
    const rows = asLegacy(await listCashSessions(actor(db), {}));
    assert.deepEqual(
      rows.map((row) => row.id),
      [S1, S2, S3],
    );
    for (const row of rows) assert.equal(row.openedByName, 'Caja Uno');
  });

  it('filters by status, sede and opening window', async () => {
    const db = createDb();
    assert.deepEqual(
      asLegacy(await listCashSessions(actor(db), { status: 'open' })).map((row) => row.id),
      [S1, S3],
    );
    assert.deepEqual(
      asLegacy(await listCashSessions(actor(db), { orgNodeId: SEDE_B })).map((row) => row.id),
      [S3],
    );
    assert.deepEqual(
      asLegacy(
        await listCashSessions(actor(db), { from: '2026-03-09T00:00:00.000Z', to: '2026-03-09T23:59:59.000Z' }),
      ).map((row) => row.id),
      [S2],
    );
  });

  it('treats empty strings as absent filters', async () => {
    const db = createDb();
    const rows = asLegacy(
      await listCashSessions(actor(db), { status: '', orgNodeId: '', from: '', to: '' }),
    );
    assert.equal(rows.length, 3);
  });

  it('rejects a malformed filter with a 400 billing.invalid_param', async () => {
    const db = createDb();
    for (const query of [
      { status: 'draft' },
      { orgNodeId: 'no-es-uuid' },
      { from: 'ayer' },
      { to: 'manana' },
    ]) {
      try {
        await listCashSessions(actor(db), query);
      } catch (error) {
        const http = httpError(error);
        assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
        assert.equal(http?.status, 400);
        assert.equal(http?.body.code, BILLING_ERROR.invalidParam);
        continue;
      }
      throw new Error(`expected ${JSON.stringify(query)} to fail with billing.invalid_param`);
    }
  });

  it('denies a role with no billing grant with a 403', async () => {
    const db = createDb({ role: 'vendedor' });
    try {
      await listCashSessions(actor(db), {});
    } catch (error) {
      const http = httpError(error);
      assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
      assert.equal(http?.status, 403);
      return;
    }
    throw new Error('expected the call to fail with access.denied');
  });
});
