// P4-3b coverage: the deferred 24h reminder lifecycle over appointments —
// schedule on confirm (deterministic job id, delay `startsAt - 24h`),
// idempotent replace on reschedule, cancel on every move out of `confirmed`,
// reminder to `confirmed` only, release of never-confirmed `scheduled` rows,
// and the 24h boundary.
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), the closed catalog from the 011 seed,
// the patient contacts, the sede timezone, and holds the agenda rows it
// mutates. The BullMQ queue is a fake (`FakeReminderQueue`, injected through
// `__setReminderQueueForTests`) — so the suite asserts the delayed jobs
// alongside the persisted rows and the `audit_log` trail, without a database
// or a broker. All data is synthetic.
// Runner: `node --test test/salud-reminder.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  __resetReminderQueueForTests,
  __setReminderQueueForTests,
  reminderJobIdFor,
  type AppointmentReminderJobData,
  type ReminderQueueLike,
} from '../src/notify/notify.service.ts';
import {
  releaseUnconfirmedAppointments,
  rescheduleAppointment,
  updateAppointmentStatus,
  type ActorContext,
  type SaludClient,
} from '../src/salud/salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a3000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b3000000-0000-4000-8000-0000000000a1';
const USER_RECEPCION = 'c3000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c3000000-0000-4000-8000-0000000000a2';
const MEMBERSHIP_ID = 'd3000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e3000000-0000-4000-8000-0000000000a1';
const PATIENT_NO_CONTACT_ID = 'e3000000-0000-4000-8000-0000000000a2';
const APPOINTMENT_ID = 'f3000000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-appointment-reminder-1';

/** Fixed clock: 2026-09-27T10:00:00Z (a date the suite reasons about). */
const NOW_MS = Date.parse('2026-09-27T10:00:00.000Z');
/** Visit 48h after `NOW_MS`: its reminder delay is exactly 24h. */
const STARTS_FAR = '2026-09-29T10:00:00.000Z';
/** Visit 12h after `NOW_MS`: its fire time already passed — never schedules. */
const STARTS_SOON = '2026-09-27T22:00:00.000Z';
/** Visit exactly 24h after `NOW_MS`: the boundary — delay 0 schedules nothing. */
const STARTS_EDGE = '2026-09-28T10:00:00.000Z';
/** Visit one hour past: releasable when still `scheduled`. */
const STARTS_PAST = '2026-09-27T09:00:00.000Z';

// ============ queue fake (no broker) ============

/** In-memory `ReminderQueueLike`: holds delayed jobs keyed by job id. */
class FakeReminderQueue implements ReminderQueueLike {
  readonly adds: Array<{ data: AppointmentReminderJobData; delayMs: number; jobId: string }> = [];
  readonly held = new Map<string, { data: AppointmentReminderJobData; delayMs: number }>();
  readonly removed: string[] = [];

  async addReminder(data: AppointmentReminderJobData, delayMs: number, jobId: string): Promise<void> {
    this.adds.push({ data, delayMs, jobId });
    this.held.set(jobId, { data, delayMs });
  }

  async removeReminder(jobId: string): Promise<boolean> {
    this.removed.push(jobId);
    return this.held.delete(jobId);
  }
}

let reminders: FakeReminderQueue;

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
    starts_at: STARTS_FAR,
    duration_min: 30,
    status: 'scheduled',
    created_at: '2026-09-27T09:00:00.000Z',
    ...overrides,
  };
}

function patientRow(id: string, contacts: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    person_name: 'Test Patient',
    document_type: 'dni',
    document_number: '12345678',
    birthdate: null,
    allergies: [],
    alerts: [],
    contacts,
    active: true,
    created_at: '2026-09-27T09:00:00.000Z',
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
}

function createDb(options: {
  readonly role: string;
  readonly userId: string;
  readonly agenda?: Record<string, unknown>[];
  readonly timezone?: string | null;
}): FakeDb {
  const queries: RecordedQuery[] = [];
  const agenda = (options.agenda ?? [appointmentRow()]).map((row) => ({ ...row }));
  const patients = [
    patientRow(PATIENT_ID, { email: 'patient@example.com', phone: '+51999999999' }),
    patientRow(PATIENT_NO_CONTACT_ID, {}),
  ];
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
        const from = String(values[2]);
        const to = String(values[3]);
        const seed = CATALOG.find((entry) => entry.from === from && entry.to === to);
        return { rows: seed === undefined ? [] : [{ allowed_roles: seed.roles }] };
      }
      if (text.includes('FROM org_nodes')) {
        return options.timezone === null || options.timezone === undefined
          ? { rows: [{}] }
          : { rows: [{ timezone: options.timezone }] };
      }
      if (text.includes('FROM patient_files')) {
        const row = patients.find((candidate) => candidate.id === values[1]);
        return { rows: row === undefined ? [] : [{ ...row }] };
      }
      if (text.includes('FROM notify_templates')) return { rows: [] };
      if (text.includes('UPDATE appointments') && text.includes('SET status')) {
        const row = agenda.find((candidate) => candidate.id === values[1]);
        if (row === undefined) return { rows: [] };
        row.status = values[2];
        return { rows: [{ ...row }] };
      }
      if (text.includes('UPDATE appointments') && text.includes('SET starts_at')) {
        const row = agenda.find((candidate) => candidate.id === values[1]);
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
        // Release sweep: `scheduled` rows in scope with `starts_at < cutoff`.
        const cutoff = String(values[2]);
        return {
          rows: agenda
            .filter((row) => row.status === 'scheduled' && String(row.starts_at) < cutoff)
            .map((row) => ({ ...row })),
        };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
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

/** Every non-denial `audit_log` action recorded, in order. */
function writes(db: FakeDb): string[] {
  return db.queries
    .filter((query) => query.text.includes('INSERT INTO audit_log'))
    .map((query) => String(query.values[2]))
    .filter((action) => !action.startsWith('access.'));
}

/** One audit entry with its decoded `diff`. */
function auditEntry(
  db: FakeDb,
  action: string,
): { action: string; diff: Record<string, unknown> } | undefined {
  const query = db.queries.find(
    (candidate) =>
      candidate.text.includes('INSERT INTO audit_log') && String(candidate.values[2]) === action,
  );
  if (query === undefined) return undefined;
  return { action, diff: JSON.parse(String(query.values[6])) as Record<string, unknown> };
}

beforeEach(() => {
  reminders = new FakeReminderQueue();
  __setReminderQueueForTests(reminders);
});

afterEach(() => {
  __resetReminderQueueForTests();
});

// ============ schedule on confirm ============

describe('24h reminder on confirm', () => {
  it('schedules one deferred entry at startsAt - 24h when the visit confirms', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
      const updated = await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'confirmed');

      assert.equal(updated.status, 'confirmed');
      assert.equal(reminders.held.size, 1);
      const held = reminders.held.get(reminderJobIdFor(APPOINTMENT_ID));
      assert.ok(held !== undefined);
      assert.equal(held.delayMs, 24 * 60 * 60 * 1000);
      assert.deepEqual(held.data.payload, {
        appointmentId: APPOINTMENT_ID,
        patientId: PATIENT_ID,
        startsAt: STARTS_FAR,
      });
      assert.equal(held.data.channel, 'email');
      assert.equal(held.data.to, 'patient@example.com');
      assert.equal(held.data.timezone, 'America/Lima');
      assert.equal(held.data.tenantId, TENANT_ID);
      assert.equal(held.data.template, 'appointment.reminder_24h');
    } finally {
      Date.now = realNow;
    }
  });

  it('sends only to confirmed: no entry when a non-confirm move runs', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({
        role: 'recepcion',
        userId: USER_RECEPCION,
        agenda: [appointmentRow({ status: 'confirmed', starts_at: STARTS_FAR })],
      });
      const updated = await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'no_show');

      assert.equal(updated.status, 'no_show');
      assert.equal(reminders.adds.length, 0);
    } finally {
      Date.now = realNow;
    }
  });

  it('schedules nothing when the patient has no address on file', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({
        role: 'recepcion',
        userId: USER_RECEPCION,
        agenda: [appointmentRow({ patient_id: PATIENT_NO_CONTACT_ID })],
      });
      await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'confirmed');
      assert.equal(reminders.adds.length, 0);
    } finally {
      Date.now = realNow;
    }
  });

  it('does not schedule when the fire time already passed (visit < 24h away)', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({
        role: 'recepcion',
        userId: USER_RECEPCION,
        agenda: [appointmentRow({ starts_at: STARTS_SOON })],
      });
      await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'confirmed');
      assert.equal(reminders.adds.length, 0);
    } finally {
      Date.now = realNow;
    }
  });

  it('treats exactly-24h as already due: the boundary never schedules', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({
        role: 'recepcion',
        userId: USER_RECEPCION,
        agenda: [appointmentRow({ starts_at: STARTS_EDGE })],
      });
      await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'confirmed');
      assert.equal(reminders.adds.length, 0);
    } finally {
      Date.now = realNow;
    }
  });

  it('skips silently without a broker: the appointment still confirms', async () => {
    __resetReminderQueueForTests();
    const savedRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
      const updated = await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'confirmed');
      assert.equal(updated.status, 'confirmed');
    } finally {
      Date.now = realNow;
      if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = savedRedisUrl;
    }
  });
});

// ============ reschedule: cancel + replace, never double ============

describe('24h reminder on reschedule', () => {
  it('replaces the entry (same job id, new fire time) instead of doubling', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({
        role: 'recepcion',
        userId: USER_RECEPCION,
        agenda: [appointmentRow({ status: 'confirmed', starts_at: STARTS_FAR })],
      });
      const movedStartsAt = '2026-09-30T10:00:00.000Z';
      const moved = await rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
        startsAt: movedStartsAt,
      });

      assert.equal(moved.startsAt, movedStartsAt);
      // Same deterministic job id, one job held: the reprogram replaced the
      // notice instead of doubling it (cancel ran first, then the fresh add).
      assert.equal(reminders.adds.length, 1);
      assert.deepEqual(reminders.removed, [reminderJobIdFor(APPOINTMENT_ID)]);
      assert.equal(reminders.held.size, 1);
      const held = reminders.held.get(reminderJobIdFor(APPOINTMENT_ID));
      assert.ok(held !== undefined);
      assert.equal(held.delayMs, 2 * 24 * 60 * 60 * 1000);
      assert.equal(held.data.payload.startsAt, movedStartsAt);
    } finally {
      Date.now = realNow;
    }
  });

  it('a rescheduled scheduled visit holds no entry (still nothing to remind)', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({ role: 'recepcion', userId: USER_RECEPCION });
      await rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
        startsAt: '2026-09-30T10:00:00.000Z',
      });
      assert.equal(reminders.adds.length, 0);
    } finally {
      Date.now = realNow;
    }
  });
});

// ============ cancel on leaving confirmed ============

describe('24h reminder on cancel', () => {
  it('drops the deferred entry when a confirmed visit cancels', async () => {
    const realNow = Date.now;
    Date.now = () => NOW_MS;
    try {
      const db = createDb({
        role: 'recepcion',
        userId: USER_RECEPCION,
        agenda: [appointmentRow({ status: 'confirmed', starts_at: STARTS_FAR })],
      });
      await rescheduleAppointment(actor(db, USER_RECEPCION), APPOINTMENT_ID, {
        startsAt: '2026-09-30T10:00:00.000Z',
      });
      assert.equal(reminders.held.size, 1);
      await updateAppointmentStatus(actor(db, USER_RECEPCION), APPOINTMENT_ID, 'cancelled');
      assert.equal(reminders.held.size, 0);
      assert.deepEqual(reminders.removed, [
        reminderJobIdFor(APPOINTMENT_ID),
        reminderJobIdFor(APPOINTMENT_ID),
      ]);
    } finally {
      Date.now = realNow;
    }
  });
});

// ============ release of never-confirmed scheduled rows ============

describe('releaseUnconfirmedAppointments', () => {
  it('cancels past scheduled visits with a release audit and no reminder', async () => {
    const db = createDb({
      role: 'recepcion',
      userId: USER_RECEPCION,
      agenda: [
        appointmentRow({ id: 'f3000000-0000-4000-8000-0000000000b1', starts_at: STARTS_PAST, status: 'scheduled' }),
        appointmentRow({ id: 'f3000000-0000-4000-8000-0000000000b2', starts_at: STARTS_FAR, status: 'scheduled' }),
        appointmentRow({ id: 'f3000000-0000-4000-8000-0000000000b3', starts_at: STARTS_PAST, status: 'confirmed' }),
      ],
    });
    const released = await releaseUnconfirmedAppointments(actor(db, USER_RECEPCION), NOW_MS);

    assert.equal(released.length, 1);
    assert.equal(released[0]?.id, 'f3000000-0000-4000-8000-0000000000b1');
    assert.equal(released[0]?.status, 'cancelled');
    assert.deepEqual(writes(db), ['appointment.released']);
    const entry = auditEntry(db, 'appointment.released');
    assert.deepEqual(entry?.diff, {
      traceId: TRACE,
      from: 'scheduled',
      to: 'cancelled',
      reason: 'unconfirmed_window_passed',
      startsAt: STARTS_PAST,
    });
    assert.equal(reminders.adds.length, 0);
  });

  it('releases nothing when every scheduled visit is still upcoming', async () => {
    const db = createDb({
      role: 'recepcion',
      userId: USER_RECEPCION,
      agenda: [appointmentRow({ starts_at: STARTS_FAR, status: 'scheduled' })],
    });
    const released = await releaseUnconfirmedAppointments(actor(db, USER_RECEPCION), NOW_MS);

    assert.equal(released.length, 0);
    assert.deepEqual(writes(db), []);
  });
});
