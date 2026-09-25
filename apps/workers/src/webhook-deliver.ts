// Webhook delivery runtime — BullMQ `webhook-deliver` worker (W2).
//
// The API enqueues deliveries as `webhook_deliveries` rows in the business
// transaction (outbox pattern, same tx as the invoice write); this module
// moves them. A lightweight relay claims due rows (`queued` with
// `next_retry_at <= now`) and adds one BullMQ job per row, and the worker
// below POSTs the signed payload, then persists the outcome back to the row —
// which is what makes retries observable (`attempts`, `next_retry_at`,
// `status`) instead of hidden inside the queue.
//
// Retry policy reuses the existing `nextRetryDelay` helper and the
// `WEBHOOK=[60,300,1800,7200,21600]` backoff from `queues.ts` (5 attempts,
// same as fiscal): attempt N fails → row back to `queued` with
// `next_retry_at = now + delay(N)`; no delay left → `failed`.
//
// `bullmq` is imported lazily inside `createWebhookWorker` (with `import
// type` for the static types, which type stripping erases), so this module —
// and its tests — load without the package installed, exactly like the
// `queues.ts` split. `buildDeliveryOutcome` and `processWebhookDelivery` are
// pure/async-pure over injected dependencies and carry the test coverage.
import type { Job, Queue, Worker } from 'bullmq';
import {
  QUEUE_CONFIGS,
  QUEUE_NAMES,
  nextRetryDelay,
  type QueueName,
} from './queues.ts';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  buildWebhookHeaders,
} from './webhook-signer.ts';

/** Queue this runtime drains (single source of truth lives in `queues.ts`). */
export const WEBHOOK_QUEUE: QueueName = QUEUE_NAMES.webhookDeliver;

/** One BullMQ job: a single delivery row claimed by the relay. */
export interface WebhookDeliveryJob {
  readonly deliveryId: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly url: string;
  readonly event: string;
  /** Exact payload bytes the outbox writer froze at enqueue time. */
  readonly payload: string;
  /** Attempts already recorded on the row before this try. */
  readonly attempts: number;
  /** HMAC secret of the subscription (resolved by the relay, never stored). */
  readonly secret: string;
}

/** Minimal HTTP surface the processor needs; `fetch` in prod, a fake in tests. */
export interface WebhookTransport {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number }>;
}

/** Outcome the worker persists back to the delivery row. */
export interface WebhookDeliveryOutcome {
  /** Next row status: `sent` on 2xx, `queued` while retries remain, else `failed`. */
  readonly status: 'sent' | 'queued' | 'failed';
  /** Attempts after this try (previous + 1). */
  readonly attempts: number;
  /** Retry delay in seconds that produced `nextRetryAt`; `null` when terminal. */
  readonly retryDelaySeconds: number | null;
  /** ISO instant the relay may re-claim the row; `null` when terminal. */
  readonly nextRetryAt: string | null;
  /** Failure cause for the operator; `null` on success. */
  readonly lastError: string | null;
}

/** Receiver is successful on any 2xx (the event is idempotent by delivery id). */
export function isDeliverySuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Pure outcome mapping: success → `sent`; failure → `queued` with the
 * configured backoff while attempts remain, `failed` once exhausted.
 * `attempt` is 1-based (the try that just ran), matching `nextRetryDelay`.
 */
export function buildDeliveryOutcome(options: {
  ok: boolean;
  status?: number;
  cause?: string;
  attempt: number;
  nowMs?: number;
}): WebhookDeliveryOutcome {
  const nowMs = options.nowMs ?? Date.now();
  const attempts = Math.max(1, options.attempt);
  if (options.ok) {
    return { status: 'sent', attempts, retryDelaySeconds: null, nextRetryAt: null, lastError: null };
  }
  const retryDelaySeconds = nextRetryDelay(WEBHOOK_QUEUE, attempts);
  if (retryDelaySeconds === null) {
    return {
      status: 'failed',
      attempts,
      retryDelaySeconds: null,
      nextRetryAt: null,
      lastError: options.cause ?? `delivery failed with status ${options.status ?? 'unknown'}`,
    };
  }
  return {
    status: 'queued',
    attempts,
    retryDelaySeconds,
    nextRetryAt: new Date(nowMs + retryDelaySeconds * 1000).toISOString(),
    lastError: options.cause ?? `delivery failed with status ${options.status ?? 'unknown'}`,
  };
}

/** Persists one outcome back to the delivery row (worker → outbox). */
export const UPDATE_DELIVERY_SQL = `UPDATE webhook_deliveries
SET status = $2, attempts = $3, next_retry_at = $4, last_error = $5
WHERE id = $1 AND tenant_id = $6`;

/**
 * Claims due deliveries for the relay: `queued` rows whose retry is due,
 * oldest first, locked so concurrent relays cannot double-claim. The relay
 * resolves each row's secret + payload and adds one BullMQ job per row.
 */
export const CLAIM_DUE_DELIVERIES_SQL = `SELECT id, tenant_id, subscription_id, event, url, payload, attempts
FROM webhook_deliveries
WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())
ORDER BY created_at ASC LIMIT $1
FOR UPDATE SKIP LOCKED`;

/** Minimal SQL surface the runtime needs (pool client or transaction). */
export interface WebhookRuntimeClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/**
 * Runs one delivery attempt: signs the exact payload bytes, POSTs them, and
 * maps the transport answer to the row outcome. Transport errors (DNS, reset,
 * timeout) count as failures with their message — they never throw past this
 * boundary, so one bad receiver cannot crash the worker.
 */
export async function processWebhookDelivery(
  job: WebhookDeliveryJob,
  transport: WebhookTransport,
  nowMs: number = Date.now(),
): Promise<{ outcome: WebhookDeliveryOutcome; headers: Record<string, string> }> {
  const headers = buildWebhookHeaders({
    secret: job.secret,
    event: job.event,
    deliveryId: job.deliveryId,
    body: job.payload,
    nowSeconds: Math.floor(nowMs / 1000),
  });
  const attempt = job.attempts + 1;
  try {
    const response = await transport.post(job.url, job.payload, {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: headers.signature,
      [WEBHOOK_TIMESTAMP_HEADER]: headers.timestamp,
      [WEBHOOK_EVENT_HEADER]: headers.event,
      [WEBHOOK_DELIVERY_HEADER]: headers.deliveryId,
    });
    if (isDeliverySuccess(response.status)) {
      return { outcome: buildDeliveryOutcome({ ok: true, attempt, nowMs }), headers: {} };
    }
    return {
      outcome: buildDeliveryOutcome({
        ok: false,
        status: response.status,
        attempt,
        nowMs,
      }),
      headers: {},
    };
  } catch (error) {
    return {
      outcome: buildDeliveryOutcome({
        ok: false,
        cause: error instanceof Error ? error.message : 'transport error',
        attempt,
        nowMs,
      }),
      headers: {},
    };
  }
}

/** Persists the outcome of one attempt (the only writer of delivery rows). */
export async function persistDeliveryOutcome(
  client: WebhookRuntimeClient,
  job: WebhookDeliveryJob,
  outcome: WebhookDeliveryOutcome,
): Promise<void> {
  await client.query(UPDATE_DELIVERY_SQL, [
    job.deliveryId,
    outcome.status,
    outcome.attempts,
    outcome.nextRetryAt,
    outcome.lastError,
    job.tenantId,
  ]);
}

/** Options of the BullMQ runtime (all injectable for tests and local runs). */
export interface WebhookWorkerOptions {
  /** Redis connection the worker listens on. */
  connection: ConstructorParameters<typeof Worker>[1];
  /** HTTP transport (`fetch`-backed in prod). */
  transport: WebhookTransport;
  /** SQL client the worker persists outcomes with. */
  client: WebhookRuntimeClient;
  /** BullMQ concurrency (one slow receiver must not stall the queue). */
  concurrency?: number;
}

/**
 * Starts the `webhook-deliver` BullMQ worker: every job is one claimed
 * delivery, delivered once per attempt and persisted before the job completes.
 * BullMQ retries are disabled (`attempts: 1`): the retry schedule lives on the
 * row (`next_retry_at`), so retries stay observable and survive restarts —
 * the relay re-claims due rows instead of the queue hiding them.
 */
export async function createWebhookWorker(options: WebhookWorkerOptions): Promise<Worker> {
  const { Worker: BullWorker } = await import('bullmq');
  const worker = new BullWorker(
    WEBHOOK_QUEUE,
    async (job: Job<WebhookDeliveryJob>) => {
      const { outcome } = await processWebhookDelivery(job.data, options.transport);
      await persistDeliveryOutcome(options.client, job.data, outcome);
      return { deliveryId: job.data.deliveryId, status: outcome.status, attempts: outcome.attempts };
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 5,
    },
  );
  return worker;
}

/** Adds one claimed delivery to the queue (relay → BullMQ). */
export async function enqueueWebhookJob(queue: Queue<WebhookDeliveryJob>, job: WebhookDeliveryJob): Promise<void> {
  await queue.add(
    WEBHOOK_QUEUE,
    job,
    {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      jobId: `${job.deliveryId}:${job.attempts + 1}`,
    },
  );
}

/** Total tries configured for the queue (initial + retries, from `queues.ts`). */
export function webhookMaxAttempts(): number {
  return QUEUE_CONFIGS[WEBHOOK_QUEUE].maxAttempts;
}
