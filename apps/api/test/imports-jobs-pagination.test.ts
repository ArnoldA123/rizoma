// Keyset pagination coverage for the import-job listing
// (`listImportJobsPage` in `../src/imports/imports.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, modules) and the listing query over synthetic rows,
// applying the same `?kind=` / `?status=` filters, keyset predicate,
// `(created_at DESC, id DESC)` order and `LIMIT` semantics as the real SQL.
// The suite walks a 3-row listing with `limit 2` through the chained
// `nextCursor` and pins the 400 on a malformed cursor plus the 500→200 clamp.
// All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listImportJobsPage,
  type ImportJobActorContext,
  type ImportJobClient,
  type ImportJobListItem,
  type ImportJobPage,
} from '../src/imports/imports.service.ts';

const TENANT = 'a3000000-0000-4000-8000-0000000000d2';
const EMPRESA = 'b3000000-0000-4000-8000-0000000000d2';
const U_GERENTE = 'd3000000-0000-4000-8000-0000000000d3';
const M_GERENTE = 'e3000000-0000-4000-8000-0000000000d3';
const J1 = 'f3000000-0000-4000-8000-0000000000d4';
const J2 = 'f3000000-0000-4000-8000-0000000000d5';
const J3 = 'f3000000-0000-4000-8000-0000000000d6';
const TRACE = 'trace-import-jobs-pagination';

type Row = Record<string, unknown>;

function jobRow(id: string, createdAt: string): Row {
  return {
    id,
    tenant_id: TENANT,
    kind: 'workers_csv',
    status: 'completed',
    rows_ok: 10,
    rows_error: 0,
    created_at: createdAt,
  };
}

interface FakeDb {
  readonly client: ImportJobClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const jobs: Row[] = [
    jobRow(J1, '2026-09-20T10:00:00.000Z'),
    jobRow(J2, '2026-09-21T10:00:00.000Z'),
    jobRow(J3, '2026-09-22T10:00:00.000Z'),
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
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'obras'] }] };
      }
      if (text.includes('FROM import_jobs j')) {
        let rows = jobs.filter((row) => String(row.tenant_id) === String(values[0]));
        if (text.includes('j.created_at < $')) {
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

function actor(db: FakeDb): ImportJobActorContext {
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

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listImportJobsPage keyset walk', () => {
  it('chains limit 2 over 3 rows without overlap or gaps', async () => {
    const db = createDb();
    const first: ImportJobPage<ImportJobListItem> = await listImportJobsPage(actor(db), {
      limit: '2',
    });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [J3, J2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second: ImportJobPage<ImportJobListItem> = await listImportJobsPage(actor(db), {
      limit: '2',
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [J1],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    for (const cursor of ['no-es-base64!!!', cursorWithoutOrderingKey()]) {
      await assert.rejects(listImportJobsPage(actor(db), { cursor }), (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      });
    }
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listImportJobsPage(actor(db), { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
