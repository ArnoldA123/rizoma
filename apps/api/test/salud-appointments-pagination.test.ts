// Appointment keyset pagination coverage (P4-2a): the stable
// `starts_at DESC, id DESC` order, the opaque cursor walk, the 200-row clamp
// and the reception-queue `excludeStatus: 'derived'` filter inside pages.
//
// Same stateful double as `salud-appointments.test.ts`, extended with the
// ordering, cursor predicate and `LIMIT` semantics of the real SQL. All data
// is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listAppointmentsPage,
  type ActorContext,
  type SaludClient,
} from '../src/salud/salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a2000000-0000-4000-8000-0000000000ab';
const SEDE_A = 'b2000000-0000-4000-8000-0000000000a1';
const USER_RECEPCION = 'c2000000-0000-4000-8000-0000000000a1';
const MEMBERSHIP_ID = 'd2000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e2000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c2000000-0000-4000-8000-0000000000a2';
const TRACE = 'trace-appointment-pagination-1';

function membershipRow(): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: USER_RECEPCION,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    role: 'recepcion',
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

function appointmentRow(id: string, startsAt: string, status = 'scheduled'): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    patient_id: PATIENT_ID,
    professional_id: USER_MEDICO,
    starts_at: startsAt,
    duration_min: 30,
    status,
    created_at: '2026-09-27T10:00:00.000Z',
  };
}

const NEWEST = 'f2000000-0000-4000-8000-0000000000a1';
const MIDDLE = 'f2000000-0000-4000-8000-0000000000a2';
const OLDEST = 'f2000000-0000-4000-8000-0000000000a3';
const DERIVED_TOP = 'f2000000-0000-4000-8000-0000000000a4';

// ============ in-memory double with SQL-shaped paging ============

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: RecordedQuery[];
}

function createDb(agenda: Record<string, unknown>[]): FakeDb {
  const queries: RecordedQuery[] = [];
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      if (text.includes('FROM memberships')) return { rows: [membershipRow()] };
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE_A }] };
      if (text.includes('FROM tenants')) return { rows: [{ modules: ['crm-core', 'salud'] }] };
      if (text.includes('FROM appointments')) {
        let rows = agenda.map((row) => ({ ...row }));
        for (const match of text.matchAll(/status (=|<>) \$(\d+)/g)) {
          const expected = String(values[Number(match[2]) - 1]);
          rows =
            match[1] === '='
              ? rows.filter((row) => row.status === expected)
              : rows.filter((row) => row.status !== expected);
        }
        // Keyset predicate `(starts_at < $n OR (starts_at = $n AND id < $m))`.
        const startsAtParam = text.match(/starts_at < \$(\d+)::timestamptz/);
        const idParam = text.match(/id < \$(\d+)::uuid/);
        if (startsAtParam !== null && idParam !== null) {
          const cursorStartsAt = String(values[Number(startsAtParam[1]) - 1]);
          const cursorId = String(values[Number(idParam[1]) - 1]);
          rows = rows.filter(
            (row) =>
              String(row.starts_at) < cursorStartsAt ||
              (String(row.starts_at) === cursorStartsAt && String(row.id) < cursorId),
          );
        }
        rows.sort(
          (a, b) =>
            String(b.starts_at).localeCompare(String(a.starts_at)) ||
            String(b.id).localeCompare(String(a.id)),
        );
        const limit = text.match(/LIMIT (\d+)/);
        if (limit !== null) rows = rows.slice(0, Number(limit[1]));
        return { rows };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(db: FakeDb): ActorContext {
  return {
    client: db.client,
    tenantId: TENANT_ID,
    userId: USER_RECEPCION,
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

describe('listAppointmentsPage', () => {
  const agenda = [
    appointmentRow(MIDDLE, '2026-10-05T15:00:00.000Z'),
    appointmentRow(OLDEST, '2026-10-04T15:00:00.000Z'),
    appointmentRow(NEWEST, '2026-10-06T15:00:00.000Z'),
  ];

  it('walks the agenda newest-first across cursors', async () => {
    const db = createDb(agenda);
    const first = await listAppointmentsPage(actor(db), { limit: 2 });

    assert.deepEqual(
      first.rows.map((row) => row.id),
      [NEWEST, MIDDLE],
    );
    assert.ok(first.nextCursor !== null, 'a full page offers the next cursor');

    const second = await listAppointmentsPage(actor(db), {
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [OLDEST],
    );
    assert.equal(second.nextCursor, null, 'the last page ends the walk');
  });

  it('keeps the reception-queue filter across pages', async () => {
    const db = createDb([
      ...agenda,
      appointmentRow(DERIVED_TOP, '2026-10-07T15:00:00.000Z', 'derived'),
    ]);
    const first = await listAppointmentsPage(actor(db), {
      limit: 2,
      excludeStatus: 'derived',
    });

    assert.deepEqual(
      first.rows.map((row) => row.id),
      [NEWEST, MIDDLE],
      'the derived visit never enters the queue, not even newest',
    );
    const second = await listAppointmentsPage(actor(db), {
      limit: 2,
      cursor: first.nextCursor,
      excludeStatus: 'derived',
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [OLDEST],
    );
    assert.equal(second.nextCursor, null);
  });

  it('clamps the page size at 200 rows', async () => {
    const db = createDb(agenda);
    const page = await listAppointmentsPage(actor(db), { limit: 500 });

    assert.ok(page.rows.length <= 3);
    const select = db.queries.find((query) => query.text.includes('FROM appointments'));
    assert.ok(select?.text.includes('LIMIT 201'), 'the query fetches limit + 1');
  });

  it('refuses a malformed cursor and a non-positive limit with 400', async () => {
    const db = createDb(agenda);
    await assert.rejects(
      async () => listAppointmentsPage(actor(db), { cursor: 'not-a-cursor' }),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 400 && http.body.code === 'validation.failed';
      },
    );
    await assert.rejects(
      async () => listAppointmentsPage(actor(db), { limit: 0 }),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });

  it('refuses an unknown page filter status with 400', async () => {
    const db = createDb(agenda);
    await assert.rejects(
      async () => listAppointmentsPage(actor(db), { excludeStatus: 'done' }),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });
});
