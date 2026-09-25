// Role-board comparison and export coverage (bases-consolidadas-v1.md §6.3).
//
// The SQL client is an in-memory double keyed by statement fragment plus the
// bound date, so the suite exercises the real day-vs-−7d legs
// (`getComparedBoard`) and the CSV shape (`exportBoard`) without Postgres.
// All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOARD_COMPARE_DAYS,
  BOARD_EXPORT_CONTENT_TYPE,
  exportBoard,
  getComparedBoard,
  getBoard,
} from './dashboards.service.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const USER_RECEPCION = 'c1000000-0000-4000-8000-0000000000a1';
const USER_CAJA = 'c1000000-0000-4000-8000-0000000000a2';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-dashboard-1';
const DAY = '2026-09-25';
const PREVIOUS_DAY = '2026-09-18';

function membershipRow(role: string, userId: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: userId,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    role,
    scopes: [],
    active: true,
    valid_from: '2025-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

// ============ in-memory double ============

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: { text: string; values: readonly unknown[] }[];
}

/**
 * Answers the guard facts (membership, subtree, tenant modules) and the board
 * aggregates. Date-filtered legs branch on the bound day (`values[2]` for the
 * recepcion leg, `values[2]` for the caja day legs); scope-state legs answer
 * identically on both legs by construction.
 */
function createDb(role: string, userId: string): FakeDb {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      if (text.includes('FROM memberships')) return { rows: [membershipRow(role, userId)] };
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE_A }] };
      if (text.includes('SELECT modules FROM tenants')) return { rows: [{ modules: ['salud'] }] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };

      // ---- recepcion leg (day-filtered) ----
      if (text.includes('today_appointments')) {
        const day = String(values[2] ?? '');
        if (day === DAY) {
          return {
            rows: [{ today_appointments: '10', waiting_avg_min: '12.5', no_shows: '1', queue: '4' }],
          };
        }
        return {
          rows: [{ today_appointments: '5', waiting_avg_min: '10', no_shows: '0', queue: '2' }],
        };
      }

      // ---- caja legs ----
      if (text.includes('today_collected')) {
        const day = String(values[2] ?? '');
        return { rows: [{ today_collected: day === DAY ? '150.50' : '100.00' }] };
      }
      if (text.includes('invoices_issued')) {
        const day = String(values[2] ?? '');
        return { rows: [{ invoices_issued: day === DAY ? '7' : '5' }] };
      }
      if (text.includes('fiscal_pending')) return { rows: [{ fiscal_pending: '3' }] };
      if (text.includes('FROM cash_sessions')) return { rows: [] };

      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(client: SaludClient, userId: string): ActorContext {
  return { client, tenantId: TENANT_ID, userId, roles: [], traceId: TRACE, ip: null };
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

// ============ comparison ============

describe('getComparedBoard (day vs −7d)', () => {
  it('returns current, previous and the per-KPI drift of the recepcion board', async () => {
    const db = createDb('recepcion', USER_RECEPCION);
    const compared = await getComparedBoard(
      actor(db.client, USER_RECEPCION),
      'recepcion',
      undefined,
      DAY,
      'previous-week',
    );

    assert.equal(BOARD_COMPARE_DAYS, 7);
    assert.equal(compared.current.date, DAY);
    assert.equal(compared.previous.date, PREVIOUS_DAY);
    assert.equal(compared.current.role, 'recepcion');
    assert.equal(compared.previous.role, 'recepcion');
    if (compared.current.role !== 'recepcion' || compared.previous.role !== 'recepcion') {
      assert.fail('expected recepcion boards on both legs');
    }
    assert.equal(compared.current.todayAppointments, 10);
    assert.equal(compared.previous.todayAppointments, 5);
    assert.deepEqual(compared.delta, {
      todayAppointments: 5,
      waitingAvgMin: 2.5,
      noShows: 1,
      queue: 2,
    });
  });

  it('returns the collected-amount drift of the caja board', async () => {
    const db = createDb('caja', USER_CAJA);
    const compared = await getComparedBoard(
      actor(db.client, USER_CAJA),
      'caja',
      undefined,
      DAY,
      'previous-week',
    );

    assert.equal(compared.current.date, DAY);
    assert.equal(compared.previous.date, PREVIOUS_DAY);
    assert.deepEqual(compared.delta, {
      todayCollected: 50.5,
      invoicesIssued: 2,
      fiscalPending: 0,
    });
  });

  it('rejects an unknown compare mode with dashboard.invalid_compare (400)', async () => {
    const db = createDb('recepcion', USER_RECEPCION);
    await assert.rejects(
      async () =>
        getComparedBoard(actor(db.client, USER_RECEPCION), 'recepcion', undefined, DAY, 'last-month'),
      (error: unknown) => {
        const http = httpError(error);
        return (
          http !== null &&
          http.status === 400 &&
          http.body.code === 'dashboard.invalid_compare'
        );
      },
    );
  });
});

// ============ export ============

describe('exportBoard (CSV)', () => {
  it('exports the recepcion aggregate with a safe filename', async () => {
    const db = createDb('recepcion', USER_RECEPCION);
    const exported = await exportBoard(
      actor(db.client, USER_RECEPCION),
      'recepcion',
      undefined,
      DAY,
      'csv',
    );

    assert.equal(exported.filename, `tablero-recepcion-${DAY}.csv`);
    assert.equal(exported.contentType, BOARD_EXPORT_CONTENT_TYPE);
    const lines = exported.csv.trim().split('\n');
    assert.equal(
      lines[0],
      'role,org_node_id,date,today_appointments,waiting_avg_min,no_shows,queue',
    );
    assert.equal(lines.length, 2);
    assert.ok(lines[1]?.includes('recepcion'));
    assert.ok(lines[1]?.includes(DAY));
    assert.ok(lines[1]?.includes('10'));
  });

  it('matches the JSON board numbers in the CSV row', async () => {
    const db = createDb('recepcion', USER_RECEPCION);
    const board = await getBoard(actor(db.client, USER_RECEPCION), 'recepcion', undefined, DAY);
    const exported = await exportBoard(
      actor(db.client, USER_RECEPCION),
      'recepcion',
      undefined,
      DAY,
      'csv',
    );
    if (board.role !== 'recepcion') assert.fail('expected a recepcion board');
    assert.ok(exported.csv.includes(String(board.todayAppointments)));
    assert.ok(exported.csv.includes(String(board.waitingAvgMin)));
  });

  it('rejects an unknown format with dashboard.invalid_format (400)', async () => {
    const db = createDb('recepcion', USER_RECEPCION);
    await assert.rejects(
      async () =>
        exportBoard(actor(db.client, USER_RECEPCION), 'recepcion', undefined, DAY, 'xlsx'),
      (error: unknown) => {
        const http = httpError(error);
        return (
          http !== null && http.status === 400 && http.body.code === 'dashboard.invalid_format'
        );
      },
    );
  });

  it('rejects a missing format with dashboard.invalid_format (400)', async () => {
    const db = createDb('recepcion', USER_RECEPCION);
    await assert.rejects(
      async () => exportBoard(actor(db.client, USER_RECEPCION), 'recepcion', undefined, DAY),
      (error: unknown) => {
        const http = httpError(error);
        return (
          http !== null && http.status === 400 && http.body.code === 'dashboard.invalid_format'
        );
      },
    );
  });
});
