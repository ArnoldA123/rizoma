// Site- and company-board comparison and export coverage
// (bases-consolidadas-v1.md §6.2).
//
// The SQL client is an in-memory double keyed by statement fragment plus the
// bound day, so the suite exercises the real day-vs-−7d legs
// (`getComparedSiteBoard`, `getComparedCompanyBoard`) and the CSV shapes
// (`exportSiteBoard`, `exportCompanyBoard`) without Postgres. All data is
// synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOARD_COMPARE_DAYS,
  BOARD_EXPORT_CONTENT_TYPE,
  exportCompanyBoard,
  exportSiteBoard,
  getComparedCompanyBoard,
  getComparedSiteBoard,
} from './dashboards.service.ts';
import type { ObraActorContext, ObraClient } from './obras.service.ts';

// ============ synthetic fixtures ============

const TENANT = 'a2000000-0000-4000-8000-0000000000a1';
const EMPRESA = 'b2000000-0000-4000-8000-000000000001';
const NODE_A = 'b2000000-0000-4000-8000-000000000003';
const SITE_A = 'c2000000-0000-4000-8000-000000000001';
const U_GERENTE = 'd2000000-0000-4000-8000-000000000001';
const M_GERENTE = 'e2000000-0000-4000-8000-000000000001';
const TRACE = 'trace-board-compare-1';
const DAY = '2026-09-25';
const PREVIOUS_DAY = '2026-09-18';
const SITE_CODE = 'OBR-A';

function siteRow(code = SITE_CODE): Record<string, unknown> {
  return {
    id: SITE_A,
    tenant_id: TENANT,
    org_node_id: NODE_A,
    code,
    name: `Obra ${code}`,
    client_name: 'Cliente Ficticio',
    budget_total: 100000,
    started_at: '2025-01-15T00:00:00.000Z',
    ended_at: null,
    status: 'active',
  };
}

// ============ in-memory double ============

interface FakeDb {
  readonly client: ObraClient;
  readonly queries: { text: string; values: readonly unknown[] }[];
}

/**
 * Answers the guard facts (membership, subtree, tenant modules, site lookup)
 * and the board aggregates. The attendance leg branches on the bound day
 * (`values[2]`); progress, stock, assets and milestones are scope-state and
 * answer identically on both legs by construction.
 */
function createDb(code = SITE_CODE): FakeDb {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const client: ObraClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
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
              valid_from: '2025-01-01T00:00:00.000Z',
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
        return { rows: [{ modules: ['obras'] }] };
      }
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        return { rows: [siteRow(code)] };
      }
      // Active-assignment lookup: gerente needs none, so the key stays empty.
      if (text.includes('FROM assignments')) return { rows: [] };

      // ---- site board legs ----
      if (text.includes('FROM budget_lines')) {
        return {
          rows: [
            {
              budget_line_id: 'b3000000-0000-4000-8000-000000000001',
              description: 'Excavacion',
              qty_planned: '100',
              qty_done: '40',
            },
          ],
        };
      }
      if (text.includes('GROUP BY status')) {
        const day = String(values[2] ?? '');
        if (day === DAY) {
          return {
            rows: [
              { status: 'registered', total: '3' },
              { status: 'approved', total: '2' },
            ],
          };
        }
        return {
          rows: [
            { status: 'registered', total: '1' },
            { status: 'approved', total: '1' },
          ],
        };
      }
      if (text.includes('FROM inventory_items')) return { rows: [] };
      if (text.includes('FROM assets')) return { rows: [] };
      if (text.includes('FROM milestones')) return { rows: [] };

      // ---- company board legs (scope-state: identical on both legs) ----
      if (text.includes('COUNT(*) AS total') && text.includes('FROM sites')) {
        return { rows: [{ total: '2', active: '1', planned: '1', closed: '0' }] };
      }
      if (text.includes('SUM(b.qty_planned)')) return { rows: [{ qty_planned: '100' }] };
      if (text.includes('SUM(p.qty_done)')) return { rows: [{ qty_done: '40' }] };

      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(client: ObraClient): ObraActorContext {
  return { client, tenantId: TENANT, userId: U_GERENTE, roles: [], traceId: TRACE, ip: null };
}

function httpError(error: unknown): { status: number; body: Record<string, unknown> } | null {
  const candidate = error as { getStatus?: () => number; getResponse?: () => unknown };
  if (typeof candidate.getStatus !== 'function' || typeof candidate.getResponse !== 'function') {
    return null;
  }
  const response = candidate.getResponse() as unknown;
  const body =
    typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
  return { status: candidate.getStatus(), body };
}

// ============ site comparison ============

describe('getComparedSiteBoard (day vs −7d)', () => {
  it('returns current, previous and the attendance drift', async () => {
    const db = createDb();
    const compared = await getComparedSiteBoard(actor(db.client), SITE_A, DAY, 'previous-week');

    assert.equal(BOARD_COMPARE_DAYS, 7);
    assert.equal(compared.current.date, DAY);
    assert.equal(compared.previous.date, PREVIOUS_DAY);
    assert.equal(compared.current.siteId, SITE_A);
    assert.equal(compared.previous.siteId, SITE_A);
    assert.equal(compared.current.attendance.total, 5);
    assert.equal(compared.previous.attendance.total, 2);
    assert.deepEqual(compared.delta, {
      attendanceRegistered: 2,
      attendanceApproved: 1,
      attendanceRejected: 0,
      attendanceAdjusted: 0,
      attendanceTotal: 3,
    });
  });

  it('rejects an unknown compare mode with validation.failed (400)', async () => {
    const db = createDb();
    await assert.rejects(
      async () => getComparedSiteBoard(actor(db.client), SITE_A, DAY, 'last-month'),
      (error: unknown) => {
        const http = httpError(error);
        return http !== null && http.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });
});

// ============ company comparison ============

describe('getComparedCompanyBoard (scope-state snapshots)', () => {
  it('labels both legs and reports a zero drift', async () => {
    const db = createDb();
    const compared = await getComparedCompanyBoard(actor(db.client), DAY, 'previous-week');

    assert.equal(compared.current.date, DAY);
    assert.equal(compared.previous.date, PREVIOUS_DAY);
    assert.equal(compared.current.progress.qtyPlanned, 100);
    assert.equal(compared.current.progress.qtyDone, 40);
    assert.deepEqual(compared.delta, {
      sitesTotal: 0,
      sitesActive: 0,
      sitesPlanned: 0,
      sitesClosed: 0,
      qtyPlanned: 0,
      qtyDone: 0,
      qtyRemaining: 0,
      percent: 0,
    });
  });

  it('rejects an unknown compare mode with validation.failed (400)', async () => {
    const db = createDb();
    await assert.rejects(
      async () => getComparedCompanyBoard(actor(db.client), DAY, 'last-month'),
      (error: unknown) => {
        const http = httpError(error);
        return http !== null && http.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });
});

// ============ exports ============

describe('exportSiteBoard and exportCompanyBoard (CSV)', () => {
  it('exports the site board with a safe filename', async () => {
    const db = createDb();
    const exported = await exportSiteBoard(actor(db.client), SITE_A, DAY, 'csv');

    assert.equal(exported.filename, `tablero-obra-${SITE_CODE}-${DAY}.csv`);
    assert.equal(exported.contentType, BOARD_EXPORT_CONTENT_TYPE);
    const lines = exported.csv.trim().split('\n');
    assert.ok(lines[0]?.startsWith('site_id,site_code,org_node_id,date,'));
    assert.equal(lines.length, 2);
    assert.ok(lines[1]?.includes(SITE_A));
    assert.ok(lines[1]?.includes(DAY));
  });

  it('scrubs an operator-controlled site code out of the filename', async () => {
    const db = createDb('OBR/A:B');
    const exported = await exportSiteBoard(actor(db.client), SITE_A, DAY, 'csv');

    assert.equal(exported.filename, `tablero-obra-OBR-A-B-${DAY}.csv`);
    assert.ok(!exported.filename.includes('/'));
    assert.ok(!exported.filename.includes(':'));
  });

  it('exports the company board as one wide row', async () => {
    const db = createDb();
    const exported = await exportCompanyBoard(actor(db.client), DAY, 'csv');

    assert.equal(exported.filename, `tablero-empresa-${DAY}.csv`);
    assert.equal(exported.contentType, BOARD_EXPORT_CONTENT_TYPE);
    const lines = exported.csv.trim().split('\n');
    assert.equal(
      lines[0],
      'org_node_id,date,sites_total,sites_active,sites_planned,sites_closed,qty_planned,qty_done,qty_remaining,percent',
    );
    assert.equal(lines.length, 2);
    assert.ok(lines[1]?.includes(DAY));
  });

  it('rejects an unknown site-export format with validation.failed (400)', async () => {
    const db = createDb();
    await assert.rejects(
      async () => exportSiteBoard(actor(db.client), SITE_A, DAY, 'xlsx'),
      (error: unknown) => {
        const http = httpError(error);
        return http !== null && http.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });

  it('rejects an unknown company-export format with validation.failed (400)', async () => {
    const db = createDb();
    await assert.rejects(
      async () => exportCompanyBoard(actor(db.client), DAY, 'xlsx'),
      (error: unknown) => {
        const http = httpError(error);
        return http !== null && http.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });
});
