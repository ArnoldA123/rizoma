// Notify send runtime — BullMQ `notify-send` worker (N2).
//
// The API enqueues notifications as `message_log` rows in the business
// transaction (outbox pattern: the `queued` row commits or rolls back with
// the business write); this module moves them. A lightweight relay claims due
// `queued` rows and adds one BullMQ job per row, and the worker below renders
// the active template at send time, delivers through the channel adapter, and
// persists the outcome back to the row — which is what makes retries
// observable instead of hidden inside the queue.
//
// Payload note: `message_log` stores no body, so the template is re-rendered
// at send time from the newest `active` version. The render variables travel
// on the job (`NotifySendJob.payload`), supplied by the producer that adds
// the BullMQ job — the relay cannot recover them from the row.
//
// Retry policy reuses the existing `nextRetryDelay` helper and the
// `NOTIFY=[60,600,3600]` backoff from `queues.ts` (3 attempts): attempt N
// fails → outcome `queued` and the worker asks for a BullMQ delayed retry of
// `delay(N)` with `attempts + 1`; no delay left → row to `failed`. The row
// itself only ever moves `queued → sent|failed` (it has no retry columns), so
// `persistNotifyOutcome` writes only terminal states and is a no-op while a
// retry is pending.
//
// `bullmq` is imported lazily inside `createNotifyWorker` (with `import
// type` for the static types, which type stripping erases), so this module —
// and its tests — load without the package installed, exactly like the
// `queues.ts` split. `renderNotifyBody`, `buildNotifySendOutcome` and
// `processNotifySend` are pure/async-pure over injected dependencies and
// carry the test coverage.
import type { Job, Queue, Worker, WorkerOptions } from 'bullmq';
import {
  NOTIFY_REMINDER_TEMPLATE,
  QUEUE_CONFIGS,
  QUEUE_NAMES,
  formatInstantInTimezone,
  nextRetryDelay,
  normalizeReminderTimezone,
  reminderDelayMs,
  reminderFireAtIso,
  reminderJobId,
  type QueueName,
} from './queues.ts';
import type { NotifyAdapter } from './notify-adapter.ts';

/** Queue this runtime drains (single source of truth lives in `queues.ts`). */
export const NOTIFY_QUEUE: QueueName = QUEUE_NAMES.notifySend;

/** One BullMQ job: a single `queued` row claimed by the relay. */
export interface NotifySendJob {
  readonly messageId: string;
  readonly tenantId: string;
  readonly channel: string;
  /** Active template `code` looked up in `notify_templates` at send time. */
  readonly template: string;
  /** Destination address (the SQL `recipient` column). */
  readonly to: string;
  /** Variables rendered into the `{{var}}` slots of the template body. */
  readonly payload: Record<string, unknown>;
  /** Attempts already recorded before this try. */
  readonly attempts: number;
}

/** Outcome the worker derives from one attempt. */
export interface NotifySendOutcome {
  /**
   * Next step: `sent` (row moves to `sent`), `failed` (row moves to
   * `failed`), or `queued` (row stays `queued`; the worker requests a
   * BullMQ delayed retry — `persistNotifyOutcome` writes nothing).
   */
  readonly status: 'sent' | 'queued' | 'failed';
  /** Attempts after this try (previous + 1). */
  readonly attempts: number;
  /** Retry delay in seconds that produced `nextRetryAt`; `null` when terminal. */
  readonly retryDelaySeconds: number | null;
  /** ISO instant the delayed retry should run; `null` when terminal. */
  readonly nextRetryAt: string | null;
  /** Cost reported by the adapter (0 for the log adapter). */
  readonly cost: number;
  /** Provider reference reported by the adapter; `null` on failure. */
  readonly providerRef: string | null;
  /** Failure cause for the operator; `null` on success. */
  readonly lastError: string | null;
}

/**
 * Renders a template body, replacing every `{{var}}` slot with the string
 * form of `payload[var]`. Mirrors `renderNotifyTemplate` in
 * `apps/api/src/notify/notify.service.ts` (kept local so workers never
 * import from the API): unknown or nullish variables render as an empty
 * string; surrounding whitespace inside the braces is ignored.
 */
export function renderNotifyBody(body: string, payload: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>(
      (current, part) => {
        if (typeof current !== 'object' || current === null) return undefined;
        return (current as Record<string, unknown>)[part];
      },
      payload,
    );
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

/**
 * Pure outcome mapping: success → `sent`; failure → `queued` with the
 * configured backoff while attempts remain, `failed` once exhausted.
 * `attempt` is 1-based (the try that just ran), matching `nextRetryDelay`.
 */
export function buildNotifySendOutcome(options: {
  ok: boolean;
  attempt: number;
  cost?: number;
  providerRef?: string | null;
  cause?: string;
  nowMs?: number;
}): NotifySendOutcome {
  const nowMs = options.nowMs ?? Date.now();
  const attempts = Math.max(1, options.attempt);
  if (options.ok) {
    return {
      status: 'sent',
      attempts,
      retryDelaySeconds: null,
      nextRetryAt: null,
      cost: options.cost ?? 0,
      providerRef: options.providerRef ?? null,
      lastError: null,
    };
  }
  const retryDelaySeconds = nextRetryDelay(NOTIFY_QUEUE, attempts);
  const lastError = options.cause ?? 'notify send failed';
  if (retryDelaySeconds === null) {
    return {
      status: 'failed',
      attempts,
      retryDelaySeconds: null,
      nextRetryAt: null,
      cost: options.cost ?? 0,
      providerRef: null,
      lastError,
    };
  }
  return {
    status: 'queued',
    attempts,
    retryDelaySeconds,
    nextRetryAt: new Date(nowMs + retryDelaySeconds * 1000).toISOString(),
    cost: options.cost ?? 0,
    providerRef: null,
    lastError,
  };
}

/** Newest `active` template version for one `(channel, code)` pair. */
export const SELECT_ACTIVE_NOTIFY_TEMPLATE_SQL = `SELECT body FROM notify_templates
WHERE tenant_id = $1 AND channel = $2 AND code = $3 AND status = 'active'
ORDER BY version DESC LIMIT 1`;

/** Terminal write: the provider accepted the notification for delivery. */
export const MARK_NOTIFY_SENT_SQL = `UPDATE message_log
SET status = 'sent', cost = $3, provider_ref = $4
WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`;

/** Terminal write: the notification failed with no retries left (or no template). */
export const MARK_NOTIFY_FAILED_SQL = `UPDATE message_log
SET status = 'failed'
WHERE id = $1 AND tenant_id = $2 AND status IN ('queued', 'sent')`;

/**
 * Claims due notifications for the relay: oldest `queued` rows first, locked
 * so concurrent relays cannot double-claim. The producer resolves each row's
 * render payload and adds one BullMQ job per row (the payload is transient —
 * see the module header).
 */
export const CLAIM_DUE_NOTIFY_SQL = `SELECT id, tenant_id, channel, template, recipient
FROM message_log
WHERE status = 'queued'
ORDER BY at ASC LIMIT $1
FOR UPDATE SKIP LOCKED`;

/** Minimal SQL surface the runtime needs (pool client or transaction). */
export interface NotifyRuntimeClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Dependencies of one send attempt (all injectable for tests). */
export interface NotifySendDependencies {
  /** Channel adapter (`log` in local/demo; a real provider in prod). */
  adapter: NotifyAdapter;
  /** SQL client for the template read (outcome writes go through `persist`). */
  client: NotifyRuntimeClient;
  /** Clock override for deterministic retries under test. */
  nowMs?: number;
}

/**
 * Runs one send attempt: loads the active template, renders it with the job
 * payload, delivers through the adapter, and maps the answer to the row
 * outcome. Adapter throws and transport errors count as failures with their
 * message — they never throw past this boundary, so one bad destination
 * cannot crash the worker. A missing template is terminal (`failed`): another
 * try would render the same nothing.
 */
export async function processNotifySend(
  job: NotifySendJob,
  deps: NotifySendDependencies,
): Promise<{ outcome: NotifySendOutcome; body: string }> {
  const nowMs = deps.nowMs ?? Date.now();
  const attempt = Math.max(1, job.attempts + 1);
  const templateResult = await deps.client.query(SELECT_ACTIVE_NOTIFY_TEMPLATE_SQL, [
    job.tenantId,
    job.channel,
    job.template,
  ]);
  const templateBody = readRows(templateResult)[0]?.body;
  if (typeof templateBody !== 'string' || templateBody === '') {
    return {
      body: '',
      outcome: {
        status: 'failed',
        attempts: attempt,
        retryDelaySeconds: null,
        nextRetryAt: null,
        cost: 0,
        providerRef: null,
        lastError: `notify.template_missing: No active template '${job.template}' for channel '${job.channel}'`,
      },
    };
  }
  const body = renderNotifyBody(templateBody, job.payload ?? {});
  try {
    const result = await deps.adapter.send({ channel: job.channel, to: job.to, body });
    if (result.ok) {
      return {
        body,
        outcome: buildNotifySendOutcome({
          ok: true,
          attempt,
          cost: result.cost,
          providerRef: result.providerRef,
          nowMs,
        }),
      };
    }
    return {
      body,
      outcome: buildNotifySendOutcome({
        ok: false,
        attempt,
        cause: result.error ?? 'notify send failed',
        nowMs,
      }),
    };
  } catch (error) {
    return {
      body,
      outcome: buildNotifySendOutcome({
        ok: false,
        attempt,
        cause: error instanceof Error ? error.message : 'notify transport error',
        nowMs,
      }),
    };
  }
}

/**
 * Persists the outcome of one attempt. Only terminal states write: `sent`
 * records cost + provider ref, `failed` closes the row, and `queued` (a retry
 * is pending) writes nothing and returns `false` — the row stays `queued`
 * while BullMQ carries the delay.
 */
export async function persistNotifyOutcome(
  client: NotifyRuntimeClient,
  job: NotifySendJob,
  outcome: NotifySendOutcome,
): Promise<boolean> {
  if (outcome.status === 'sent') {
    await client.query(MARK_NOTIFY_SENT_SQL, [
      job.messageId,
      job.tenantId,
      outcome.cost,
      outcome.providerRef,
    ]);
    return true;
  }
  if (outcome.status === 'failed') {
    await client.query(MARK_NOTIFY_FAILED_SQL, [job.messageId, job.tenantId]);
    return true;
  }
  return false;
}

/** Options of the BullMQ runtime (all injectable for tests and local runs). */
export interface NotifyWorkerOptions {
  /** Redis connection the worker listens on. */
  connection: WorkerOptions['connection'];
  /** Channel adapter the worker delivers through. */
  adapter: NotifyAdapter;
  /** SQL client the worker reads templates and persists outcomes with. */
  client: NotifyRuntimeClient;
  /**
   * Pending-retry hook: called with the job at `outcome.attempts` and the
   * `retryDelaySeconds` when an attempt ends `queued`. Prod wires it to
   * `queue.add` with `{ delay }`; tests use a fake. Defaults to a no-op
   * (the row stays `queued` for the relay to re-claim).
   */
  onRetry?: (job: NotifySendJob, delaySeconds: number) => Promise<void>;
  /** BullMQ concurrency (one slow provider must not stall the queue). */
  concurrency?: number;
  /**
   * Live appointment-status read for deferred reminder jobs (P4-3b). The
   * entrypoint wires it to the pool; without it a reminder job cannot prove
   * `confirmed` and is skipped as missing — never sent blind.
   */
  loadAppointmentStatus?: (tenantId: string, appointmentId: string) => Promise<string | null>;
}

/**
 * Starts the `notify-send` BullMQ worker: every job is one claimed
 * notification, rendered and delivered once per attempt, persisted before the
 * job completes. BullMQ retries are disabled (`attempts: 1`): the retry
 * schedule lives in the outcome (`nextRetryDelay`) and the delayed retry is
 * re-added through `onRetry`, so retries stay observable and survive
 * restarts — exactly like the `webhook-deliver` row schedule.
 *
 * Deferred 24h reminders (P4-3b) share this queue under the
 * `REMINDER_JOB_NAME` job name: the processor dispatches them to
 * `processAppointmentReminderFire` (live `confirmed` re-check, sede-time
 * render, one `sent` row) instead of the outbox path.
 */
export async function createNotifyWorker(options: NotifyWorkerOptions): Promise<Worker> {
  const { Worker: BullWorker } = await import('bullmq');
  const onRetry = options.onRetry ?? (async () => {});
  const worker = new BullWorker(
    NOTIFY_QUEUE,
    async (job: Job<NotifySendJob>) => {
      if (job.name === REMINDER_JOB_NAME) {
        const data: unknown = job.data;
        if (!isAppointmentReminderJobData(data)) {
          return { appointmentId: '', outcome: 'failed', providerRef: null };
        }
        const fired = await processAppointmentReminderFire(data, {
          adapter: options.adapter,
          client: options.client,
          loadAppointmentStatus: options.loadAppointmentStatus ?? (async () => null),
        });
        return {
          appointmentId: fired.appointmentId,
          outcome: fired.outcome,
          providerRef: fired.providerRef,
        };
      }
      const { outcome } = await processNotifySend(job.data, {
        adapter: options.adapter,
        client: options.client,
      });
      await persistNotifyOutcome(options.client, job.data, outcome);
      if (outcome.status === 'queued' && outcome.retryDelaySeconds !== null) {
        await onRetry(
          { ...job.data, attempts: outcome.attempts },
          outcome.retryDelaySeconds,
        );
      }
      return {
        messageId: job.data.messageId,
        status: outcome.status,
        attempts: outcome.attempts,
      };
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 5,
    },
  );
  return worker;
}

/** Adds one claimed notification to the queue (relay → BullMQ). */
export async function enqueueNotifyJob(queue: Queue<NotifySendJob>, job: NotifySendJob): Promise<void> {
  await queue.add(
    NOTIFY_QUEUE,
    job,
    {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      jobId: `${job.messageId}:${job.attempts + 1}`,
    },
  );
}

/** Total tries configured for the queue (initial + retries, from `queues.ts`). */
export function notifyMaxAttempts(): number {
  return QUEUE_CONFIGS[NOTIFY_QUEUE].maxAttempts;
}

// ============ deferred 24h appointment reminder (P4-3) ============
//
// The API schedules one delayed `notify-send` job per confirmed appointment
// (fire time `startsAt - 24h`, deterministic id `reminderJobId`); this
// section is the worker side: an in-memory scheduler the tests and the
// local/demo runtime share (the log adapter sends, no real provider), plus
// the fire-time guard that keeps the P4 decision — notice to `confirmed`
// only. A BullMQ queue replaces `ReminderScheduler` without touching the
// call sites: `scheduleAppointmentReminder` / `cancelAppointmentReminder`
// keep their shape, and the job payload already carries everything the
// delayed BullMQ job would need.

/** Payload a deferred reminder job carries (mirrors the contracts schema). */
export interface AppointmentReminderPayload {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly startsAt: string | null;
}

/** One deferred reminder: the delayed job, in memory or on BullMQ. */
export interface ScheduledAppointmentReminder {
  /** Deterministic id (`reminderJobId`): rescheduling overwrites, never doubles. */
  readonly jobId: string;
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly channel: string;
  /** Template `code` rendered at fire time (always the 24h reminder). */
  readonly template: string;
  /** Destination address (the SQL `recipient` column at send time). */
  readonly to: string;
  readonly payload: AppointmentReminderPayload;
  /** Sede zone used to render `{{startsAtLocal}}` (`org_nodes.timezone`, Lima fallback). */
  readonly timezone: string;
  /** ISO instant the reminder fires (`startsAt - 24h`). */
  readonly fireAt: string;
}

/** Minimal scheduler surface: an in-memory map today, BullMQ tomorrow. */
export interface ReminderScheduler {
  schedule(entry: ScheduledAppointmentReminder): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

/** Input the API-side hook resolves (contact + sede zone) before scheduling. */
export interface AppointmentReminderInput {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly patientId: string;
  readonly startsAt: string | null;
  readonly channel: string;
  readonly to: string;
  readonly timezone?: string;
}

/** Answer of one schedule attempt (never throws: the caller stays best-effort). */
export interface ReminderScheduleResult {
  readonly scheduled: boolean;
  readonly jobId: string;
  /** ISO fire time, or `null` when nothing was scheduled. */
  readonly fireAt: string | null;
  /** Why nothing was scheduled (`already_due`, `invalid_input`, `scheduler_error`). */
  readonly reason: string | null;
}

/**
 * In-memory deferred emitter (scout P4-0): holds the delayed reminders of
 * the process keyed by deterministic job id. `schedule` upserts, so
 * reprogramming a confirmed visit replaces its job instead of stacking a
 * second notice; `cancel` drops it. `due` pops every entry whose fire time
 * reached `nowMs`, oldest first — the worker drains it at fire time.
 */
export class InMemoryReminderScheduler implements ReminderScheduler {
  private readonly entries = new Map<string, ScheduledAppointmentReminder>();

  async schedule(entry: ScheduledAppointmentReminder): Promise<void> {
    this.entries.set(entry.jobId, entry);
  }

  async cancel(jobId: string): Promise<void> {
    this.entries.delete(jobId);
  }

  /** Entries currently held, oldest fire time first (a copy). */
  pending(): ScheduledAppointmentReminder[] {
    return [...this.entries.values()].sort((a, b) =>
      a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0,
    );
  }

  /** Removes and returns every entry with `fireAt <= nowMs`, oldest first. */
  due(nowMs: number): ScheduledAppointmentReminder[] {
    const ready = this.pending().filter((entry) => Date.parse(entry.fireAt) <= nowMs);
    for (const entry of ready) this.entries.delete(entry.jobId);
    return ready;
  }
}

/** Builds the schedulable entry, or `null` when the fire time already passed. */
export function buildScheduledReminder(
  input: AppointmentReminderInput,
): ScheduledAppointmentReminder | null {
  const fireAt = reminderFireAtIso(input.startsAt);
  if (fireAt === null) return null;
  return {
    jobId: reminderJobId(input.appointmentId),
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    channel: input.channel,
    template: NOTIFY_REMINDER_TEMPLATE,
    to: input.to,
    payload: {
      appointmentId: input.appointmentId,
      patientId: input.patientId,
      startsAt: input.startsAt,
    },
    timezone: normalizeReminderTimezone(input.timezone),
    fireAt,
  };
}

/**
 * Schedules the deferred 24h notice on the scheduler. Idempotent by job id:
 * calling it again for the same appointment (reprogrammed `startsAt`)
 * replaces the entry, so the patient never gets two notices. Returns
 * `scheduled: false` — never throws — when the fire time already passed
 * (visit less than 24h away), the input is unusable, or the scheduler
 * fails: the appointment write that triggered it must always commit.
 */
export async function scheduleAppointmentReminder(
  scheduler: ReminderScheduler,
  input: AppointmentReminderInput,
  nowMs: number = Date.now(),
): Promise<ReminderScheduleResult> {
  const jobId = reminderJobId(input.appointmentId);
  const fail = (reason: string): ReminderScheduleResult => ({
    scheduled: false,
    jobId,
    fireAt: null,
    reason,
  });
  if (
    typeof input.appointmentId !== 'string' || input.appointmentId.trim() === '' ||
    typeof input.patientId !== 'string' || input.patientId.trim() === '' ||
    typeof input.to !== 'string' || input.to.trim() === '' ||
    (input.channel !== 'email' && input.channel !== 'sms')
  ) {
    return fail('invalid_input');
  }
  const delayMs = reminderDelayMs(input.startsAt, nowMs);
  if (delayMs === null) return fail('already_due');
  const entry = buildScheduledReminder(input);
  if (entry === null) return fail('already_due');
  try {
    await scheduler.schedule(entry);
  } catch {
    return fail('scheduler_error');
  }
  return { scheduled: true, jobId, fireAt: entry.fireAt, reason: null };
}

/**
 * Cancels the deferred notice of one appointment (status change, new date,
 * cancellation, release). Best-effort and never throws: a missing job is
 * the common case (the visit was never confirmed), not an error.
 */
export async function cancelAppointmentReminder(
  scheduler: ReminderScheduler,
  appointmentId: string,
): Promise<void> {
  try {
    await scheduler.cancel(reminderJobId(appointmentId));
  } catch {
    // Best-effort: the business write owns the transaction, the notice never blocks it.
  }
}

/**
 * Fire-time guard (P4 decision): only a `confirmed` appointment sends.
 * Any other status — `scheduled` that never confirmed, `cancelled`,
 * `no_show`, past clinical states — skips without touching the adapter.
 */
export function shouldSendReminder(appointmentStatus: string | null | undefined): boolean {
  return appointmentStatus === 'confirmed';
}

/** Terminal write of a fired reminder: the notice the patient received. */
export const RECORD_REMINDER_SENT_SQL = `INSERT INTO message_log
  (tenant_id, channel, template, recipient, status, cost, provider_ref)
VALUES ($1, $2, $3, $4, 'sent', $5, $6)`;

/** Fire-time status read: the guard decides on the live row, not the job. */
export const SELECT_APPOINTMENT_STATUS_SQL = `SELECT status FROM appointments
WHERE tenant_id = $1 AND id = $2 LIMIT 1`;

/** Dependencies of the fire-time drain (all injectable for tests). */
export interface ReminderDrainDependencies {
  /** Channel adapter (`log` in local/demo; a real provider in prod). */
  adapter: NotifyAdapter;
  /** SQL client for the template read and the `sent` row. */
  client: NotifyRuntimeClient;
  /** Live status of the appointment (`null` = row gone). */
  loadAppointmentStatus: (tenantId: string, appointmentId: string) => Promise<string | null>;
  /** Clock override for deterministic drains under test. */
  nowMs?: number;
}

/** Outcome of one fired reminder. */
export interface ReminderDrainResult {
  readonly jobId: string;
  readonly appointmentId: string;
  /** `sent`, or why nothing went out (`skipped_status`, `skipped_missing`, `failed`). */
  readonly outcome: 'sent' | 'skipped_status' | 'skipped_missing' | 'failed';
  readonly providerRef: string | null;
}

// ============ production 24h reminder fire (P4-3b) ============
//
// The API schedules one delayed BullMQ job per confirmed appointment on the
// `notify-send` queue (job name `REMINDER_JOB_NAME`, deterministic id
// `reminderJobId`, delay `startsAt - 24h`); `processAppointmentReminderFire`
// below is what runs when it fires. The job carries the contact + sede zone
// resolved at schedule time, and firing re-checks the live appointment
// status first — only a still-`confirmed` visit sends. `createNotifyWorker`
// dispatches here by job name, so outbox jobs and reminder jobs share the
// one worker without touching each other's shape.

/** BullMQ job name of the deferred 24h reminder (shares the `notify-send` queue). */
export const REMINDER_JOB_NAME = 'appointment-reminder-24h';

/** Data the API puts on one deferred reminder job. */
export interface AppointmentReminderJobData {
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly channel: string;
  /** Template `code` rendered at fire time (always the 24h reminder). */
  readonly template: string;
  /** Destination address (the SQL `recipient` column at send time). */
  readonly to: string;
  readonly payload: AppointmentReminderPayload;
  /** Sede zone used to render `{{startsAtLocal}}` (`org_nodes.timezone`, Lima fallback). */
  readonly timezone: string;
}

/** Outcome of one fired production reminder. */
export interface ReminderFireResult {
  readonly appointmentId: string;
  /** `sent`, or why nothing went out (`skipped_status`, `skipped_missing`, `failed`). */
  readonly outcome: 'sent' | 'skipped_status' | 'skipped_missing' | 'failed';
  readonly providerRef: string | null;
}

/**
 * Dependencies of one production fire (all injectable for tests — no `pg`
 * import here; the entrypoint wires the pool).
 */
export interface ReminderFireDependencies {
  /** Channel adapter (`log` in local/demo; a real provider in prod). */
  adapter: NotifyAdapter;
  /** SQL client for the template read, the status re-check and the `sent` row. */
  client: NotifyRuntimeClient;
  /** Live status of the appointment (`null` = row gone). */
  loadAppointmentStatus: (tenantId: string, appointmentId: string) => Promise<string | null>;
  /** Clock override for deterministic fires under test. */
  nowMs?: number;
}

/**
 * True when the data looks like a deferred reminder job (never throws).
 */
export function isAppointmentReminderJobData(data: unknown): data is AppointmentReminderJobData {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  const blank = (value: unknown): boolean =>
    typeof value !== 'string' || value.trim() === '';
  return (
    !blank(record.tenantId) &&
    !blank(record.appointmentId) &&
    (record.channel === 'email' || record.channel === 'sms') &&
    !blank(record.template) &&
    !blank(record.to) &&
    typeof record.payload === 'object' && record.payload !== null &&
    !blank(record.timezone)
  );
}

/**
 * Fires one deferred reminder: re-checks the live appointment status, and —
 * only for `confirmed` — renders the active 24h template (with
 * `{{startsAtLocal}}` in sede time) and delivers through the adapter,
 * recording one `sent` `message_log` row. Anything else skips silently.
 * Never throws: adapter throws, transport errors and SQL failures all
 * surface as `failed`, so one bad destination cannot crash the worker. A
 * missing template is `failed` too: another try would render the same
 * nothing, and a late duplicate notice is worse than a missed one.
 */
export async function processAppointmentReminderFire(
  data: AppointmentReminderJobData,
  deps: ReminderFireDependencies,
): Promise<ReminderFireResult> {
  const failed = (providerRef: string | null = null): ReminderFireResult => ({
    appointmentId:
      typeof data?.appointmentId === 'string' ? data.appointmentId : '',
    outcome: 'failed',
    providerRef,
  });
  try {
    let status: string | null;
    try {
      status = await deps.loadAppointmentStatus(data.tenantId, data.appointmentId);
    } catch {
      return failed();
    }
    if (status === null) {
      return { appointmentId: data.appointmentId, outcome: 'skipped_missing', providerRef: null };
    }
    if (!shouldSendReminder(status)) {
      return { appointmentId: data.appointmentId, outcome: 'skipped_status', providerRef: null };
    }
    const templateResult = await deps.client.query(SELECT_ACTIVE_NOTIFY_TEMPLATE_SQL, [
      data.tenantId,
      data.channel,
      data.template,
    ]);
    const templateBody = readRows(templateResult)[0]?.body;
    if (typeof templateBody !== 'string' || templateBody === '') {
      return failed();
    }
    const body = renderNotifyBody(templateBody, {
      ...(data.payload as Record<string, unknown>),
      startsAtLocal: formatInstantInTimezone(data.payload.startsAt, data.timezone),
    });
    let send: Awaited<ReturnType<NotifyAdapter['send']>>;
    try {
      send = await deps.adapter.send({ channel: data.channel, to: data.to, body });
    } catch {
      return failed();
    }
    if (!send.ok) {
      return failed();
    }
    try {
      await deps.client.query(RECORD_REMINDER_SENT_SQL, [
        data.tenantId,
        data.channel,
        data.template,
        data.to,
        send.cost,
        send.providerRef,
      ]);
    } catch {
      return failed(send.providerRef);
    }
    return { appointmentId: data.appointmentId, outcome: 'sent', providerRef: send.providerRef };
  } catch {
    return failed();
  }
}

/**
 * Drains every due deferred reminder: pops the entries whose fire time
 * reached `nowMs`, re-checks the live appointment status, and — only for
 * `confirmed` — renders the active 24h template (with `{{startsAtLocal}}`
 * in sede time) and delivers through the adapter, recording one `sent`
 * `message_log` row. Anything else skips silently: a released `scheduled`
 * visit, a cancelled visit or a deleted row produces no notice, no row, no
 * adapter call. Adapter throws and transport errors count as `failed` —
 * they never throw past this boundary, so one bad destination cannot crash
 * the worker. A missing template is `failed` too: another try would render
 * the same nothing.
 */
export async function drainDueReminders(
  scheduler: InMemoryReminderScheduler,
  deps: ReminderDrainDependencies,
): Promise<ReminderDrainResult[]> {
  const nowMs = deps.nowMs ?? Date.now();
  const results: ReminderDrainResult[] = [];
  for (const entry of scheduler.due(nowMs)) {
    // Same production fire path the BullMQ worker runs (P4-3b): one entry
    // carries exactly one job's data, so the drain stays byte-identical.
    const fired = await processAppointmentReminderFire(entry, deps);
    results.push({
      jobId: entry.jobId,
      appointmentId: fired.appointmentId,
      outcome: fired.outcome,
      providerRef: fired.providerRef,
    });
  }
  return results;
}
