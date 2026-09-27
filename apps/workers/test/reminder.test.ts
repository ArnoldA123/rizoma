// P4-3 coverage (workers side): the pure scheduling contract
// (`reminderJobId`, `reminderDelayMs`, sede-local formatting), the in-memory
// deferred scheduler (idempotent schedule, cancel, due drain), and the
// fire-time drain — `confirmed` sends through the log adapter and records
// one `sent` row, anything else skips without touching the adapter.
//
// Everything here is pure or seam-injected (in-memory scheduler, log
// adapter, fake SQL client, fixed clock): no Redis, no BullMQ connection,
// no network. All identifiers are synthetic.
// Runner: `node --test test/reminder.test.ts` (type stripping).
// NOTE: wire this file into the `test` script of `apps/workers/package.json`
// (today it only runs the `src/*.test.ts` files).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LogNotifyAdapter } from '../src/notify-adapter.ts';
import {
  InMemoryReminderScheduler,
  cancelAppointmentReminder,
  drainDueReminders,
  isAppointmentReminderJobData,
  processAppointmentReminderFire,
  scheduleAppointmentReminder,
  shouldSendReminder,
  type AppointmentReminderJobData,
  type NotifyRuntimeClient,
  type ReminderDrainDependencies,
  type ReminderFireDependencies,
} from '../src/notify-send.ts';
import {
  runReleaseSweep,
} from '../src/release-sweep.ts';
import {
  formatInstantInTimezone,
  reminderDelayMs,
  reminderFireAtIso,
  reminderJobId,
} from '../src/queues.ts';

const NOW_MS = Date.parse('2026-09-27T10:00:00.000Z');
const TENANT = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const APPOINTMENT = 'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PATIENT = 'd2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const STARTS_FAR = '2026-09-29T10:00:00.000Z';
const FIRE_FAR = '2026-09-28T10:00:00.000Z';
const TEMPLATE_BODY = 'Reminder: appointment {{appointmentId}} on {{startsAtLocal}}.';

function input(overrides: Record<string, unknown> = {}): Parameters<typeof scheduleAppointmentReminder>[1] {
  return {
    tenantId: TENANT,
    appointmentId: APPOINTMENT,
    patientId: PATIENT,
    startsAt: STARTS_FAR,
    channel: 'email',
    to: 'patient@example.com',
    timezone: 'America/Lima',
    ...overrides,
  } as Parameters<typeof scheduleAppointmentReminder>[1];
}

/** SQL client that serves one template body and records every query. */
function clientWithTemplate(body: string | null): NotifyRuntimeClient & {
  seen: Array<{ text: string; values: readonly unknown[] }>;
} {
  const seen: Array<{ text: string; values: readonly unknown[] }> = [];
  return {
    seen,
    async query(text: string, values?: readonly unknown[]) {
      seen.push({ text, values: values ?? [] });
      if (text.includes('FROM notify_templates')) {
        return body === null ? { rows: [] } : { rows: [{ body }] };
      }
      return { rows: [] };
    },
  };
}

function drainDeps(
  client: NotifyRuntimeClient,
  statuses: Record<string, string | null>,
  adapter = new LogNotifyAdapter({ now: () => NOW_MS }),
): { deps: ReminderDrainDependencies; adapter: LogNotifyAdapter } {
  const log = adapter instanceof LogNotifyAdapter ? adapter : new LogNotifyAdapter({ now: () => NOW_MS });
  return {
    adapter: log,
    deps: {
      adapter: log,
      client,
      loadAppointmentStatus: async (_tenantId, appointmentId) =>
        appointmentId in statuses ? (statuses[appointmentId] as string | null) : null,
      nowMs: NOW_MS,
    },
  };
}

// ============ pure scheduling contract ============

describe('reminder scheduling math', () => {
  it('derives a deterministic job id from the appointment id', () => {
    assert.equal(reminderJobId(APPOINTMENT), `appointment-reminder-24h:${APPOINTMENT}`);
    assert.equal(reminderJobId(APPOINTMENT), reminderJobId(APPOINTMENT));
  });

  it('fires exactly 24h before the visit', () => {
    assert.equal(reminderFireAtIso(STARTS_FAR), FIRE_FAR);
    assert.equal(reminderDelayMs(STARTS_FAR, NOW_MS), 24 * 60 * 60 * 1000);
  });

  it('schedules nothing once the fire time passed (visit < 24h away)', () => {
    assert.equal(reminderDelayMs('2026-09-27T22:00:00.000Z', NOW_MS), null);
    assert.equal(reminderDelayMs(STARTS_FAR, Date.parse(FIRE_FAR) + 1), null);
  });

  it('treats exactly-24h as already due: the boundary never schedules', () => {
    assert.equal(reminderDelayMs('2026-09-28T10:00:00.000Z', NOW_MS), null);
  });

  it('schedules nothing for an unparseable start', () => {
    assert.equal(reminderDelayMs(null, NOW_MS), null);
    assert.equal(reminderDelayMs('', NOW_MS), null);
    assert.equal(reminderDelayMs('not-a-date', NOW_MS), null);
    assert.equal(reminderFireAtIso('not-a-date'), null);
  });

  it('formats the instant in sede time, never UTC', () => {
    // 10:00 UTC is 05:00 in Lima (UTC-5, no DST).
    assert.equal(formatInstantInTimezone('2026-09-29T15:00:00.000Z', 'America/Lima'), '2026-09-29 10:00');
    assert.equal(formatInstantInTimezone('2026-09-29T15:00:00.000Z', 'UTC'), '2026-09-29 15:00');
  });

  it('falls back to Lima on a bad zone or instant instead of throwing', () => {
    assert.equal(
      formatInstantInTimezone('2026-09-29T15:00:00.000Z', 'Mars/Olympus'),
      '2026-09-29 10:00',
    );
    assert.equal(formatInstantInTimezone(null, 'America/Lima'), '');
  });
});

// ============ in-memory scheduler: idempotent schedule, cancel ============

describe('InMemoryReminderScheduler', () => {
  it('schedules one entry with the deterministic job id and fire time', async () => {
    const scheduler = new InMemoryReminderScheduler();
    const result = await scheduleAppointmentReminder(scheduler, input(), NOW_MS);

    assert.equal(result.scheduled, true);
    assert.equal(result.jobId, reminderJobId(APPOINTMENT));
    assert.equal(result.fireAt, FIRE_FAR);
    assert.equal(result.reason, null);
    assert.equal(scheduler.pending().length, 1);
  });

  it('rescheduling replaces the entry instead of doubling the notice', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
    const moved = await scheduleAppointmentReminder(
      scheduler,
      input({ startsAt: '2026-09-30T10:00:00.000Z' }),
      NOW_MS,
    );

    assert.equal(moved.scheduled, true);
    assert.equal(moved.fireAt, '2026-09-29T10:00:00.000Z');
    assert.equal(scheduler.pending().length, 1);
    assert.equal(scheduler.pending()[0]?.payload.startsAt, '2026-09-30T10:00:00.000Z');
  });

  it('cancelling drops the entry; cancelling a missing one is a no-op', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
    await cancelAppointmentReminder(scheduler, APPOINTMENT);
    assert.equal(scheduler.pending().length, 0);
    await cancelAppointmentReminder(scheduler, APPOINTMENT);
    assert.equal(scheduler.pending().length, 0);
  });

  it('refuses to schedule without a usable input, and never throws', async () => {
    const scheduler = new InMemoryReminderScheduler();
    for (const bad of [
      input({ to: '  ' }),
      input({ channel: 'whatsapp' }),
      input({ startsAt: '2026-09-27T22:00:00.000Z' }),
      input({ appointmentId: '' }),
    ]) {
      const result = await scheduleAppointmentReminder(scheduler, bad, NOW_MS);
      assert.equal(result.scheduled, false);
    }
    assert.equal(scheduler.pending().length, 0);
  });

  it('due pops only the entries whose fire time arrived, oldest first', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(
      scheduler,
      input({ appointmentId: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01', startsAt: '2026-09-30T10:00:00.000Z' }),
      NOW_MS,
    );
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);

    assert.equal(scheduler.due(NOW_MS).length, 0);
    const ready = scheduler.due(Date.parse(FIRE_FAR));
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.appointmentId, APPOINTMENT);
    assert.equal(scheduler.pending().length, 1);
  });
});

// ============ fire-time drain: confirmed sends, the rest skips ============

describe('drainDueReminders', () => {
  it('sends a confirmed reminder in sede time and records one sent row', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
    const client = clientWithTemplate(TEMPLATE_BODY);
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const { deps } = drainDeps(client, { [APPOINTMENT]: 'confirmed' }, adapter);

    const results = await drainDueReminders(scheduler, { ...deps, nowMs: Date.parse(FIRE_FAR) });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, 'sent');
    assert.equal(typeof results[0]?.providerRef, 'string');
    // The patient reads sede time (10:00Z is 05:00 in Lima), never the UTC instant.
    assert.match(adapter.sent[0]?.body ?? '', /2026-09-29 05:00/);
    assert.match(adapter.sent[0]?.body ?? '', new RegExp(APPOINTMENT));
    const inserts = client.seen.filter((query) => query.text.includes('INSERT INTO message_log'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0]?.values.slice(1, 4), ['email', 'appointment.reminder_24h', 'patient@example.com']);
    assert.equal(inserts[0]?.values[0], TENANT);
    assert.equal(scheduler.pending().length, 0);
  });

  it('skips a scheduled visit that never confirmed: no adapter call, no row', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
    const client = clientWithTemplate(TEMPLATE_BODY);
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const { deps } = drainDeps(client, { [APPOINTMENT]: 'scheduled' }, adapter);

    const results = await drainDueReminders(scheduler, { ...deps, nowMs: Date.parse(FIRE_FAR) });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, 'skipped_status');
    assert.equal(adapter.sent.length, 0);
    assert.equal(client.seen.filter((query) => query.text.includes('INSERT INTO message_log')).length, 0);
  });

  it('skips a cancelled visit and a deleted row without sending', async () => {
    for (const statuses of [{ [APPOINTMENT]: 'cancelled' }, { [APPOINTMENT]: 'no_show' }, {}]) {
      const scheduler = new InMemoryReminderScheduler();
      await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
      const client = clientWithTemplate(TEMPLATE_BODY);
      const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
      const { deps } = drainDeps(client, statuses, adapter);

      const results = await drainDueReminders(scheduler, { ...deps, nowMs: Date.parse(FIRE_FAR) });

      assert.equal(results.length, 1);
      assert.ok(results[0]?.outcome === 'skipped_status' || results[0]?.outcome === 'skipped_missing');
      assert.equal(adapter.sent.length, 0);
    }
  });

  it('fails a confirmed reminder without an active template, without sending', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
    const client = clientWithTemplate(null);
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const { deps } = drainDeps(client, { [APPOINTMENT]: 'confirmed' }, adapter);

    const results = await drainDueReminders(scheduler, { ...deps, nowMs: Date.parse(FIRE_FAR) });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, 'failed');
    assert.equal(adapter.sent.length, 0);
  });

  it('drains nothing before the fire time', async () => {
    const scheduler = new InMemoryReminderScheduler();
    await scheduleAppointmentReminder(scheduler, input(), NOW_MS);
    const client = clientWithTemplate(TEMPLATE_BODY);
    const { deps } = drainDeps(client, { [APPOINTMENT]: 'confirmed' });

    assert.deepEqual(await drainDueReminders(scheduler, deps), []);
    assert.equal(scheduler.pending().length, 1);
  });
});

describe('shouldSendReminder', () => {
  it('sends only to confirmed', () => {
    assert.equal(shouldSendReminder('confirmed'), true);
    for (const status of ['scheduled', 'checked_in', 'in_care', 'completed', 'no_show', 'cancelled', 'derived', null, undefined, '']) {
      assert.equal(shouldSendReminder(status), false);
    }
  });
});

// ============ production fire: the BullMQ job path (P4-3b) ============

function reminderJob(overrides: Record<string, unknown> = {}): AppointmentReminderJobData {
  return {
    tenantId: TENANT,
    appointmentId: APPOINTMENT,
    channel: 'email',
    template: 'appointment.reminder_24h',
    to: 'patient@example.com',
    payload: { appointmentId: APPOINTMENT, patientId: PATIENT, startsAt: STARTS_FAR },
    timezone: 'America/Lima',
    ...overrides,
  } as AppointmentReminderJobData;
}

function fireDeps(
  client: NotifyRuntimeClient,
  statuses: Record<string, string | null>,
  adapter = new LogNotifyAdapter({ now: () => NOW_MS }),
): ReminderFireDependencies {
  return {
    adapter,
    client,
    loadAppointmentStatus: async (_tenantId, appointmentId) =>
      appointmentId in statuses ? (statuses[appointmentId] as string | null) : null,
    nowMs: NOW_MS,
  };
}

describe('processAppointmentReminderFire', () => {
  it('sends a confirmed reminder in sede time and records one sent row', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const fired = await processAppointmentReminderFire(
      reminderJob(),
      fireDeps(client, { [APPOINTMENT]: 'confirmed' }, adapter),
    );

    assert.equal(fired.appointmentId, APPOINTMENT);
    assert.equal(fired.outcome, 'sent');
    assert.equal(typeof fired.providerRef, 'string');
    assert.match(adapter.sent[0]?.body ?? '', /2026-09-29 05:00/);
    const inserts = client.seen.filter((query) => query.text.includes('INSERT INTO message_log'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0]?.values.slice(1, 4), ['email', 'appointment.reminder_24h', 'patient@example.com']);
  });

  it('skips a non-confirmed visit without touching the adapter', async () => {
    for (const statuses of [{ [APPOINTMENT]: 'scheduled' }, { [APPOINTMENT]: 'cancelled' }, {}]) {
      const client = clientWithTemplate(TEMPLATE_BODY);
      const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
      const fired = await processAppointmentReminderFire(
        reminderJob(),
        fireDeps(client, statuses, adapter),
      );

      assert.ok(fired.outcome === 'skipped_status' || fired.outcome === 'skipped_missing');
      assert.equal(fired.providerRef, null);
      assert.equal(adapter.sent.length, 0);
      assert.equal(client.seen.filter((query) => query.text.includes('INSERT INTO message_log')).length, 0);
    }
  });

  it('fails when the status lookup throws, without sending', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const fired = await processAppointmentReminderFire(reminderJob(), {
      adapter,
      client,
      loadAppointmentStatus: async () => {
        throw new Error('db down');
      },
      nowMs: NOW_MS,
    });

    assert.equal(fired.outcome, 'failed');
    assert.equal(adapter.sent.length, 0);
  });

  it('fails a confirmed reminder without an active template, without sending', async () => {
    const client = clientWithTemplate(null);
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const fired = await processAppointmentReminderFire(
      reminderJob(),
      fireDeps(client, { [APPOINTMENT]: 'confirmed' }, adapter),
    );

    assert.equal(fired.outcome, 'failed');
    assert.equal(adapter.sent.length, 0);
  });

  it('fails when the adapter throws, without recording a row', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const failing = {
      name: 'failing',
      async send() {
        throw new Error('transport down');
      },
    };
    const fired = await processAppointmentReminderFire(reminderJob(), {
      adapter: failing,
      client,
      loadAppointmentStatus: async () => 'confirmed',
      nowMs: NOW_MS,
    });

    assert.equal(fired.outcome, 'failed');
    assert.equal(client.seen.filter((query) => query.text.includes('INSERT INTO message_log')).length, 0);
  });
});

describe('isAppointmentReminderJobData', () => {
  it('accepts a well-formed reminder job and rejects anything else', () => {
    assert.equal(isAppointmentReminderJobData(reminderJob()), true);
    for (const bad of [
      null,
      undefined,
      'appointment-reminder-24h',
      reminderJob({ channel: 'whatsapp' }),
      reminderJob({ to: '  ' }),
      reminderJob({ appointmentId: '' }),
      reminderJob({ payload: null }),
    ]) {
      assert.equal(isAppointmentReminderJobData(bad), false);
    }
  });
});

// ============ release sweep: the 15-minute repeatable (P4-3b) ============

const SWEEP_ORG = 'b1c2d3e4-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const STARTS_PAST = '2026-09-27T09:00:00.000Z';

function sweepRow(id: string, startsAt: string, status: string): Record<string, unknown> {
  return { id, tenant_id: TENANT, org_node_id: SWEEP_ORG, starts_at: startsAt, status };
}

/** SQL double answering the sweep statements over a mutable agenda. */
function sweepClient(
  agenda: Array<Record<string, unknown>>,
  seen: Array<{ text: string; values: readonly unknown[] }>,
  options: { loseRaceFor?: string; throwFor?: string } = {},
): NotifyRuntimeClient {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      seen.push({ text, values });
      if (text.includes('FROM appointments')) {
        const cutoff = String(values[0]);
        const limit = Number(values[1]);
        return {
          rows: agenda
            .filter((row) => row.status === 'scheduled' && String(row.starts_at) < cutoff)
            .slice(0, limit)
            .map((row) => ({ ...row })),
        };
      }
      if (text.includes('UPDATE appointments')) {
        if (values[1] === options.throwFor) throw new Error('db down');
        if (values[1] === options.loseRaceFor) return { rows: [] };
        const row = agenda.find(
          (candidate) =>
            candidate.tenant_id === values[0] &&
            candidate.id === values[1] &&
            candidate.status === 'scheduled',
        );
        if (row === undefined) return { rows: [] };
        row.status = 'cancelled';
        return { rows: [{ ...row }] };
      }
      return { rows: [] };
    },
  };
}

describe('runReleaseSweep', () => {
  it('releases past scheduled visits with a system audit and drops their reminder job', async () => {
    const agenda = [
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01', STARTS_PAST, 'scheduled'),
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c02', STARTS_FAR, 'scheduled'),
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c03', STARTS_PAST, 'confirmed'),
    ];
    const seen: Array<{ text: string; values: readonly unknown[] }> = [];
    const cancelled: string[] = [];
    const result = await runReleaseSweep(sweepClient(agenda, seen), {
      nowMs: NOW_MS,
      cancelReminder: async (appointmentId) => {
        cancelled.push(appointmentId);
      },
    });

    assert.equal(result.checked, 1);
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0]?.id, 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01');
    assert.equal(result.released[0]?.tenantId, TENANT);
    assert.deepEqual(cancelled, ['a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01']);
    const audits = seen.filter((query) => query.text.includes('INSERT INTO audit_log'));
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.values.slice(0, 6), [
      TENANT,
      'system',
      'appointment.released',
      'appointment',
      'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01',
      SWEEP_ORG,
    ]);
    assert.deepEqual(JSON.parse(String(audits[0]?.values[6])), {
      from: 'scheduled',
      to: 'cancelled',
      reason: 'unconfirmed_window_passed',
      startsAt: STARTS_PAST,
    });
  });

  it('releases nothing when every scheduled visit is still upcoming (boundary excluded)', async () => {
    const agenda = [
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01', STARTS_FAR, 'scheduled'),
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c02', new Date(NOW_MS).toISOString(), 'scheduled'),
    ];
    const seen: Array<{ text: string; values: readonly unknown[] }> = [];
    const result = await runReleaseSweep(sweepClient(agenda, seen), { nowMs: NOW_MS });

    assert.equal(result.checked, 0);
    assert.deepEqual(result.released, []);
    assert.equal(seen.filter((query) => query.text.includes('INSERT INTO audit_log')).length, 0);
  });

  it('skips a visit the desk confirmed concurrently (lost race releases nothing)', async () => {
    const agenda = [sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01', STARTS_PAST, 'scheduled')];
    const seen: Array<{ text: string; values: readonly unknown[] }> = [];
    const result = await runReleaseSweep(
      sweepClient(agenda, seen, { loseRaceFor: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01' }),
      { nowMs: NOW_MS },
    );

    assert.equal(result.checked, 1);
    assert.deepEqual(result.released, []);
    assert.equal(seen.filter((query) => query.text.includes('INSERT INTO audit_log')).length, 0);
  });

  it('continues past one failing row and still releases the rest', async () => {
    const agenda = [
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01', STARTS_PAST, 'scheduled'),
      sweepRow('a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c02', STARTS_PAST, 'scheduled'),
    ];
    const seen: Array<{ text: string; values: readonly unknown[] }> = [];
    const result = await runReleaseSweep(
      sweepClient(agenda, seen, { throwFor: 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c01' }),
      { nowMs: NOW_MS },
    );

    assert.equal(result.checked, 2);
    assert.equal(result.released.length, 1);
    assert.equal(result.released[0]?.id, 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c02');
  });
});
