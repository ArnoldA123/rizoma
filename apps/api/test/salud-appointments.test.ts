// Appointment transition coverage (P4-2a): the closed machine over
// `state_transitions` (entity `appointment`, migration 011), the desk / owning
// medico guard split, rescheduling, derivation and the reception-queue filter.
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), holds the agenda rows it mutates
// through the UPDATE statements, and emulates the closed catalog from the 011
// seed — so the suite asserts the persisted row and the `audit_log` rows
// without a database. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveAppointment,
  listAppointments,
  rescheduleAppointment,
  updateAppointmentStatus,
  type ActorContext,
  type AppointmentRecord,
  type SaludClient,
} from '../src/salud/salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a2000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b2000000-0000-4000-8000-0000000000a1';
const USER_RECEPCION = 'c2000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c2000000-0000-4000-8000-0000000000a2';
const USER_MEDICO_OTHER = 'c2000000-0000-4000-8000-0000000000a3';
const USER_CAJA = 'c2000000-0000-4000-8000-0000000000a4';
const MEMBERSHIP_ID = 'd2000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e2000000-0000-4000-8000-0000000000a1';
const APPOINTMENT_ID = 'f2000000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-appointment-transition-1';

/** Closed machine seed, mirroring migration 011. */
const CATALOG: readonly { from: string; to: string; roles: string[] }[] = [
  { from: 'scheduled', to: 'confirmed', roles: ['recepcion', 'medico'] },
  { from: 'scheduled', to: 'cancelled', roles: ['recepcion', 'medico'] },
  { from: 'scheduled', to: 'derived', roles: ['medico'] },
  { from: 'confirmed', to: 'checked_in', roles: ['recepcion', 'medico'] },
  { from: 'confirmed', to: 'no_show', roles: ['recepcion', 'medico'] },
  { from: 'confirmed', to: 'cancelled', roles: ['recepcion', 'medico'] },
  { from: 'checked_in', to: 'in_care', roles: ['medico'] },
  { from: 'in_care', to: 'completed', roles: ['medico'] },
];

function membershipRow(role: string, userId: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: userId,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    role,
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

function appointmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPOINTMENT_ID,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    patient_id: PATIENT_ID,
    professional_id: USER_MEDICO,
    starts_at: '2026-10-05T15:00:00.000Z',
    duration_min: 30,
    status: 'scheduled',
    created_at: '2026-09-27T10:00:00.000Z',
    ...overrides,
  };
}

// ============ stateful in-memory double ============

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: RecordedQuery[];
  readonly agenda: Record<string, unknown>[];
}

function createDb(options: {
  readonly role: string;
  readonly userId: string;
  readonly agenda?: Record<string, unknown>[];
}): FakeDb {
  const queries: RecordedQuery[] = [];
  const agenda = (options.agenda ?? [appointmentRow()]).map((row) => ({ ...row }));
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return { rows: [membershipRow(options.role, options.userId)] };
      }
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE_A }] };
      if (text.includes('FROM tenants')) return { rows: [{ modules: ['crm-core', 'salud'] }] };
      if (text.includes('FROM state_transitions')) {
        const [, , from, to] = values as [string, string, string, string];
        const seed = CATALOG.find((entry) => entry.from === from && entry.to === to);
        return { rows: seed === undefined ? [] : [{ allowed_roles: seed.roles }] };
      }
      if (text.includes('UPDATE appointments') && text.includes('SET status')) {
        const id = String(values[1]);
        const row = agenda.find((candidate) => candidate.id === id);
        if (row === undefined) return { rows: [] };
        row.status = values[2];
        return { rows: [{ ...row }] };
      }
      if (text.includes('UPDATE appointments') && text.includes('SET starts_at')) {
        const id = String(values[1]);
        const row = agenda.find((candidate) => candidate.id === id);
        if (row === undefined) return { rows: [] };
        row.starts_at = values[2];
        row.duration_min = values[3];
        return { rows: [{ ...row }] };
      }
      if (text.includes('FROM appointments')) {
        if (!Array.isArray(values[1])) {
          const row = agenda.find((candidate) => candidate.id === values[1]);
          return { rows: row === undefined ? [] : [{ ...row }] };
        }
        let rows = agenda.map((row) => ({ ...row }));
        for (const match of text.matchAll(/status (=|<>) \$(\d+)/g)) {
          const expected = String(values[Number(match[2]) - 1]);
          rows =
            match[1] === '='
              ? rows.filter((row) => row.status === expected)
              : rows.filter((row) => row.status !== expected);
        }
        return { rows };
      }
      return { rows: [] };
    },
  };
  return { client, queries, agenda };
}

/** Every `audit_log` insert, with its action and decoded `diff`. */
function audits(db: FakeDb): { action: string; diff: Record<string, unknown> }[] {
  return db.queries
    .filter((query) => query.text.includes('INSERT INTO audit_log'))
    .map((query) => ({
      action: String(query.values[2]),
      diff: JSON.parse(String(query.values[6])) as Record<string, unknown>,
    }));
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

function actor(db: FakeDb, userId: string): ActorContext {
  return {
    client: db.client,
    tenantId: TENANT_ID,
    userId,
    roles: [],
    traceId: TRACE,
    ip: null,
  };
}

function writes(db: FakeDb): { action: string; diff: Record<string, unknown> }[] {
  return audits(db).filter((entry) => !entry.action.startsWith('access.'));
}

describe('updateAppointmentStatus', () => {
  it('lets recepcion confirm a scheduled visit with one audit row', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    const updated = await updateAppointmentStatus(
      actor(db, USER_RECEPCION),
      APPOINTMENT_ID,
      'confirmed',
    );

    assert.equal(updated.status, 'confirmed');
    const trail = writes(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'appointment.status_changed');
    assert.deepEqual(trail[0]?.diff, {
      traceId: TRACE,
      from: 'scheduled',
      to: 'confirmed',
    });
  });

  it('lets the owning medico confirm its own visit', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO });
    const updated = await updateAppointmentStatus(actor(db, USER_MEDICO), APPOINTMENT_ID, 'confirmed');

    assert.equal(updated.status, 'confirmed');
    assert.equal(writes(db).length, 1);
  });

  it('denies a medico over somebody else’s agenda with 403', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO_OTHER });
    await assert.rejects(
      async () => updateAppointmentStatus(actor(db, USER_MEDICO_OTHER), APPOINTMENT_ID, 'confirmed'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0, 'a denied move writes no audit row of its own');
  });

  it('denies caja as today with 403', async () => {
    const db = createDb({ role: 'caja', userId: USER_CAJA });
    await assert.rejects(
      async () => updateAppointmentStatus(actor(db, USER_CAJA), APPOINTMENT_ID, 'confirmed'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('refuses an unknown status with 400', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    await assert.rejects(
      async () => updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'done'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });

  it('refuses a move the catalog does not list with 403', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    await assert.rejects(
      async () => updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'completed'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('refuses a move out of a terminal state with 403', async () => {
    const db = createDb({
      role: 'recepcion',
      userId: USER_RECEPCION,
      agenda: [appointmentRow({ status: 'completed' })],
    });
    await assert.rejects(
      async () => updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'cancelled'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
  });

  it('answers 404 for an unknown appointment', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION, agenda: [] });
    await assert.rejects(
      async () =>
        updateAppointmentStatus(
          actor(db, USER_RECEPCION),
          'f2000000-0000-4000-8000-0000000000ff',
          'confirmed',
        ),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 404 && http.body.code === 'not_found';
      },
    );
  });

  it('returns the row untouched when the status is already set', async () => {
    const db = createDb({
      role: 'recepcion',
      userId: USER_RECEPCION,
      agenda: [appointmentRow({ status: 'confirmed' })],
    });
    const same = await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'confirmed');

    assert.equal(same.status, 'confirmed');
    assert.equal(writes(db).length, 0, 'an idempotent move audits nothing');
  });

  it('walks the full desk + clinical path to completed', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO });
    const me = actor(db, USER_MEDICO);
    // `confirmed` and `checked_in` list `medico` in the grant, so the owning
    // medico can walk the whole path in this double.
    assert.equal((await updateAppointmentStatus(me, APPOINTMENT_ID, 'confirmed')).status, 'confirmed');
    const dbCheckedIn = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      agenda: [appointmentRow({ status: 'confirmed' })],
    });
    assert.equal(
      (await updateAppointmentStatus(actor(dbCheckedIn, USER_MEDICO), APPOINTMENT_ID, 'checked_in'))
        .status,
      'checked_in',
    );
    const dbInCare = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      agenda: [appointmentRow({ status: 'checked_in' })],
    });
    assert.equal(
      (await updateAppointmentStatus(actor(dbInCare, USER_MEDICO), APPOINTMENT_ID, 'in_care')).status,
      'in_care',
    );
    const dbDone = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      agenda: [appointmentRow({ status: 'in_care' })],
    });
    assert.equal(
      (await updateAppointmentStatus(actor(dbDone, USER_MEDICO), APPOINTMENT_ID, 'completed')).status,
      'completed',
    );
    assert.equal(db.agenda[0]?.status, 'confirmed', 'each double holds its own persisted row');
  });
});

describe('rescheduleAppointment', () => {
  it('moves the slot of a scheduled visit and audits the old/new instants', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    const updated: AppointmentRecord = await rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
      startsAt: '2026-10-06T10:00:00.000Z',
      durationMin: 45,
    });

    assert.equal(updated.startsAt, '2026-10-06T10:00:00.000Z');
    assert.equal(updated.durationMin, 45);
    assert.equal(updated.status, 'scheduled', 'a reschedule keeps the status');
    const trail = writes(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'appointment.rescheduled');
    assert.equal(trail[0]?.diff.from, '2026-10-05T15:00:00.000Z');
    assert.equal(trail[0]?.diff.to, '2026-10-06T10:00:00.000Z');
  });

  it('keeps the duration when the body omits it', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    const updated = await rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
      startsAt: '2026-10-06T10:00:00.000Z',
    });

    assert.equal(updated.durationMin, 30);
  });

  it('refuses a visit already in care with 403', async () => {
    const db = createDb({
      role: 'recepcion',
      userId: USER_RECEPCION,
      agenda: [appointmentRow({ status: 'in_care' })],
    });
    await assert.rejects(
      async () =>
        rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
          startsAt: '2026-10-06T10:00:00.000Z',
        }),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('refuses an unparseable instant and a non-positive duration with 400', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    await assert.rejects(
      async () =>
        rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, { startsAt: 'tomorrow' }),
      (error: unknown) => httpError(error)?.status === 400,
    );
    await assert.rejects(
      async () =>
        rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
          startsAt: '2026-10-06T10:00:00.000Z',
          durationMin: 0,
        }),
      (error: unknown) => httpError(error)?.status === 400,
    );
  });

  it('denies caja with 403', async () => {
    const db = createDb({ role: 'caja', userId: USER_CAJA });
    await assert.rejects(
      async () =>
        rescheduleAppointment(actor(db, USER_CAJA), APPOINTMENT_ID, {
          startsAt: '2026-10-06T10:00:00.000Z',
        }),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
  });
});

describe('deriveAppointment', () => {
  it('lets the owning medico derive a scheduled visit with one audit row', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO });
    const derived = await deriveAppointment(actor(db, USER_MEDICO), APPOINTMENT_ID);

    assert.equal(derived.status, 'derived');
    const trail = writes(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'appointment.derived');
    assert.deepEqual(trail[0]?.diff, { traceId: TRACE, from: 'scheduled', to: 'derived' });
  });

  it('denies the desk deriving: a derivation is a medico-only clinical act', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
    await assert.rejects(
      async () => deriveAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('denies caja with 403', async () => {
    const db = createDb({ role: 'caja', userId: USER_CAJA });
    await assert.rejects(
      async () => deriveAppointment(actor(db, USER_CAJA), APPOINTMENT_ID),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('refuses a derivation out of confirmed with 403 (only scheduled derives)', async () => {
    const db = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      agenda: [appointmentRow({ status: 'confirmed' })],
    });
    await assert.rejects(
      async () => deriveAppointment(actor(db, USER_MEDICO), APPOINTMENT_ID),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
  });

  it('returns the row untouched when already derived', async () => {
    const db = createDb({
      role: 'recepcion',
      userId: USER_RECEPCION,
      agenda: [appointmentRow({ status: 'derived' })],
    });
    const same = await deriveAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID);

    assert.equal(same.status, 'derived');
    assert.equal(writes(db).length, 0);
  });
});

describe('listAppointments derived filter', () => {
  const DERIVED_ID = 'f2000000-0000-4000-8000-0000000000b2';
  const agenda = [
    appointmentRow(),
    appointmentRow({ id: DERIVED_ID, status: 'derived' }),
  ];

  it('lists every status by default', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION, agenda });
    const rows = await listAppointments(actor(db, USER_RECEPCION), null);

    assert.equal(rows.length, 2);
  });

  it('drops derived rows for the reception queue filter', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION, agenda });
    const rows = await listAppointments(actor(db, USER_RECEPCION), null, {
      excludeStatus: 'derived',
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, APPOINTMENT_ID);
  });

  it('keeps a single status on demand', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION, agenda });
    const rows = await listAppointments(actor(db, USER_RECEPCION), null, { status: 'derived' });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, DERIVED_ID);
  });

  it('refuses an unknown filter status with 400', async () => {
    const db = createDb({ role: 'recepcion', userId: USER_RECEPCION, agenda });
    await assert.rejects(
      async () => listAppointments(actor(db, USER_RECEPCION), null, { status: 'done' }),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 400 && http.body.code === 'validation.failed';
      },
    );
  });
});
