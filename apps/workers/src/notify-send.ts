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
  QUEUE_CONFIGS,
  QUEUE_NAMES,
  nextRetryDelay,
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
}

/**
 * Starts the `notify-send` BullMQ worker: every job is one claimed
 * notification, rendered and delivered once per attempt, persisted before the
 * job completes. BullMQ retries are disabled (`attempts: 1`): the retry
 * schedule lives in the outcome (`nextRetryDelay`) and the delayed retry is
 * re-added through `onRetry`, so retries stay observable and survive
 * restarts — exactly like the `webhook-deliver` row schedule.
 */
export async function createNotifyWorker(options: NotifyWorkerOptions): Promise<Worker> {
  const { Worker: BullWorker } = await import('bullmq');
  const onRetry = options.onRetry ?? (async () => {});
  const worker = new BullWorker(
    NOTIFY_QUEUE,
    async (job: Job<NotifySendJob>) => {
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
