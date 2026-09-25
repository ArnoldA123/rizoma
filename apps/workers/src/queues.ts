// Queue definitions and pure scheduling helpers (bases-consolidadas-v1.md
// §5.2-§5.3, peru-anexo-v1.md §4.2).
//
// This module holds configuration and pure helpers only. It opens no Redis or
// BullMQ connection: the runtime that wires BullMQ lives in a later task, and
// keeping this file dependency-free lets it be imported from tests without the
// `bullmq`/`ioredis` packages installed.
//
// Retry policy:
// - fiscal-emit: 5 attempts, backoff 1m / 5m / 30m / 2h / 6h,
// - notify-send: 3 attempts, backoff 1m / 10m / 1h,
// - webhook-deliver: 5 attempts, same backoff as fiscal.
//
// Only workers call provider/fiscal adapters; the API enqueues intents and
// reads state.

export const QUEUE_NAMES = {
  fiscalEmit: 'fiscal-emit',
  notifySend: 'notify-send',
  webhookDeliver: 'webhook-deliver',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Fiscal backoff in seconds (base §5.3): 1m / 5m / 30m / 2h / 6h. */
export const FISCAL_RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600] as const;

/** Notify backoff in seconds: 1m / 10m / 1h. */
export const NOTIFY_RETRY_DELAYS_SECONDS = [60, 600, 3600] as const;

/** Webhook backoff in seconds: 1m / 5m / 30m / 2h / 6h. */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600] as const;

export const RETRY_DELAYS_SECONDS: Record<QueueName, readonly number[]> = {
  [QUEUE_NAMES.fiscalEmit]: FISCAL_RETRY_DELAYS_SECONDS,
  [QUEUE_NAMES.notifySend]: NOTIFY_RETRY_DELAYS_SECONDS,
  [QUEUE_NAMES.webhookDeliver]: WEBHOOK_RETRY_DELAYS_SECONDS,
};

export interface QueueConfig {
  name: QueueName;
  maxAttempts: number;
  retryDelaysSeconds: readonly number[];
}

export const QUEUE_CONFIGS: Record<QueueName, QueueConfig> = {
  [QUEUE_NAMES.fiscalEmit]: {
    name: QUEUE_NAMES.fiscalEmit,
    maxAttempts: FISCAL_RETRY_DELAYS_SECONDS.length,
    retryDelaysSeconds: FISCAL_RETRY_DELAYS_SECONDS,
  },
  [QUEUE_NAMES.notifySend]: {
    name: QUEUE_NAMES.notifySend,
    maxAttempts: NOTIFY_RETRY_DELAYS_SECONDS.length,
    retryDelaysSeconds: NOTIFY_RETRY_DELAYS_SECONDS,
  },
  [QUEUE_NAMES.webhookDeliver]: {
    name: QUEUE_NAMES.webhookDeliver,
    maxAttempts: WEBHOOK_RETRY_DELAYS_SECONDS.length,
    retryDelaysSeconds: WEBHOOK_RETRY_DELAYS_SECONDS,
  },
};

// ============ idempotency ============

/** Header required on every critical POST (base §5.1). */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Key window in seconds (base §5.1: 24 h, persisted in idempotency_keys). */
export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;

export interface IdempotencyRecord {
  requestHash: string;
  response: unknown;
  expiresAt: number;
}

export type IdempotencyDecision =
  | { kind: 'new' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'conflict' };

/**
 * Pure idempotency resolution for a stored key (base §5.1): same key + same
 * body replays the stored response, same key + different body is a conflict
 * (`409 idempotency_conflict`), and a missing/expired key is new.
 */
export function decideIdempotency(
  record: IdempotencyRecord | undefined,
  requestHash: string,
  nowMs: number,
): IdempotencyDecision {
  if (!record || record.expiresAt <= nowMs) return { kind: 'new' };
  if (record.requestHash === requestHash) {
    return { kind: 'replay', response: record.response };
  }
  return { kind: 'conflict' };
}

/** Expiry instant for a key first seen at `nowMs` (24 h window). */
export function idempotencyExpiry(nowMs: number): number {
  return nowMs + IDEMPOTENCY_WINDOW_SECONDS * 1000;
}

// ============ event types ============

export const FISCAL_EVENTS = [
  'fiscal.emit.requested',
  'fiscal.emit.sent',
  'fiscal.emit.accepted',
  'fiscal.emit.rejected',
  'fiscal.emit.contingency',
] as const;
export type FiscalEvent = (typeof FISCAL_EVENTS)[number];

export const NOTIFY_EVENTS = [
  'notify.send.requested',
  'notify.send.sent',
  'notify.send.failed',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export const WEBHOOK_EVENTS = [
  'webhook.deliver.requested',
  'webhook.deliver.delivered',
  'webhook.deliver.failed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type QueueEvent = FiscalEvent | NotifyEvent | WebhookEvent;

// ============ pure scheduling helpers ============

/**
 * Returns the delay in seconds before the given retry attempt, or `null` when
 * the queue has exhausted its attempts.
 *
 * `attempt` is 1-based: attempt 1 is the first retry, so it maps to the first
 * configured delay.
 */
export function nextRetryDelay(queue: QueueName, attempt: number): number | null {
  const delays = RETRY_DELAYS_SECONDS[queue];
  if (!delays || !Number.isInteger(attempt) || attempt < 1) return null;
  return attempt <= delays.length ? delays[attempt - 1] : null;
}

/** Total number of attempts (initial + retries) configured for a queue. */
export function maxAttempts(queue: QueueName): number {
  return QUEUE_CONFIGS[queue].maxAttempts;
}
