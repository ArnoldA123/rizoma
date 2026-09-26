// Import-job listing coverage (`listImportJobs` in
// `../src/imports/imports.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, modules) and the listing query over synthetic rows,
// applying the same `?kind=` / `?status=` filters, `(created_at DESC, id
// DESC)` order and `LIMIT` semantics as the real SQL. `import_jobs` carries no
// org column, so the guard is the membership plus the role/module terms — the
// suite pins the legacy bare array (newest first, cap 200), both filters, the
// 400 on malformed input, the 403 on a caller with no import grant and the
// 403 on a tenant with no import module. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listImportJobs,
  type ImportJobActorContext,
  type ImportJobClient,
  type ImportJobListItem,
} from '../src/imports/imports.service.ts';

const TENANT = 'a3000000-0000-4000-8000-0000000000d1';
const EMPRESA = 'b3000000-0000-4000-8000-0000000000d1';
const U_GERENTE = 'd3000000-0000-4000-8000-0000000000d1';
const U_SOPORTE = 'd3000000-0000-4000-8000-0000000000d2';
const M_GERENTE = 'e3000000-0000-4000-8000-0000000000d1';
const M_SOPORTE = 'e3000000-0000-4000-8000-0000000000d2';
const J1 = 'f3000000-0000-4000-8000-0000000000d1';
const J2 = 'f3000000-0000-4000-8000-0000000000d2';
const J3 = 'f3000000-0000-4000-8000-0000000000d3';
const TRACE = 'trace-import-jobs-list';

type Row = Record<string, unknown>;

function jobRow(
  id: string,
  kind: string,
  status: string,
  createdAt: string,
): Row {
  return {
    id,
    tenant_id: TENANT,
    kind,
    status,
    rows_ok: 10,
    rows_error: 0,
    created_at: createdAt,
  };
}

interface FakeOptions {
  readonly role?: string;
  readonly userId?: string;
  readonly membershipId?: string;
  readonly modules?: string[];
}

interface FakeDb {
  readonly client: ImportJobClient;
  readonly queries: string[];
}

function createDb(options: FakeOptions = {}): FakeDb {
  const queries: string[] = [];
  const role = options.role ?? 'gerente';
  const userId = options.userId ?? U_GERENTE;
  const membershipId = options.membershipId ?? M_GERENTE;
  const modules = options.modules ?? ['crm-core', 'obras'];
  const jobs: Row[] = [
    jobRow(J1, 'workers_csv', 'completed', '2026-09-20T10:00:00.000Z'),
    jobRow(J2, 'assets_csv', 'completed', '2026-09-21T10:00:00.000Z'),
    jobRow(J3, 'workers_csv', 'failed', '2026-09-22T10:00:00.000Z'),
  ];

  function limitOf(text: string): number {
    const match = text.match(/LIMIT (\d+)\s*$/);
    return match === null ? 200 : Number(match[1]);
  }

  const client: ImportJobClient = {
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
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules }] };
      }
      if (text.includes('FROM import_jobs j')) {
        let rows = jobs.filter((row) => String(row.tenant_id) === String(values[0]));
        const kindParam = text.match(/j\.kind = \$(\d+)/);
        if (kindParam !== null) {
          const wanted = String(values[Number(kindParam[1]) - 1]);
          rows = rows.filter((row) => String(row.kind) === wanted);
        }
        const statusParam = text.match(/j\.status = \$(\d+)/);
        if (statusParam !== null) {
          const wanted = String(values[Number(statusParam[1]) - 1]);
          rows = rows.filter((row) => String(row.status) === wanted);
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

function actor(db: FakeDb, userId: string = U_GERENTE): ImportJobActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId,
    roles: [],
    traceId: TRACE,
    ip: '127.0.0.1',
  };
}

function httpStatus(error: unknown): number | null {
  const candidate = error as { getStatus?: () => number };
  return typeof candidate.getStatus === 'function' ? candidate.getStatus() : null;
}

describe('listImportJobs legacy listing', () => {
  it('returns the tenant jobs as a bare array, newest first', async () => {
    const db = createDb();
    const rows: ImportJobListItem[] = await listImportJobs(actor(db), {});
    assert.deepEqual(
      rows.map((row) => row.id),
      [J3, J2, J1],
    );
    assert.deepEqual(Object.keys(rows[0] as Record<string, unknown>).sort(), [
      'createdAt',
      'id',
      'kind',
      'rowsError',
      'rowsOk',
      'status',
    ]);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 200')),
      `expected the legacy cap, saw: ${db.queries.join(' | ')}`,
    );
  });

  it('filters by kind and by status', async () => {
    const db = createDb();
    const byKind = await listImportJobs(actor(db), { kind: 'workers_csv' });
    assert.deepEqual(
      byKind.map((row) => row.id),
      [J3, J1],
    );
    const byStatus = await listImportJobs(actor(db), { status: 'failed' });
    assert.deepEqual(
      byStatus.map((row) => row.id),
      [J3],
    );
  });

  it('rejects an unknown filter with a 400', async () => {
    const db = createDb();
    for (const query of [{ kind: 'nope_csv' }, { status: 'exploded' }]) {
      await assert.rejects(listImportJobs(actor(db), query), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('denies a role with no import grant with a 403', async () => {
    const db = createDb({ role: 'soporte', userId: U_SOPORTE, membershipId: M_SOPORTE });
    await assert.rejects(listImportJobs(actor(db, U_SOPORTE), {}), (error: unknown) => {
      assert.equal(httpStatus(error), 403);
      return true;
    });
  });

  it('denies a tenant with no import module with a 403', async () => {
    const db = createDb({ modules: ['crm-core'] });
    await assert.rejects(listImportJobs(actor(db), {}), (error: unknown) => {
      assert.equal(httpStatus(error), 403);
      return true;
    });
  });
});
