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

// ============ deferred 24h appointment reminder (P4-3) ============
//
// Pure scheduling contract of the deferred reminder: one delayed
// `notify-send` job per confirmed appointment, fired at `startsAt - 24h`.
// The deterministic job id makes rescheduling idempotent (reprogramming
// overwrites the same job instead of stacking a second notice) and gives
// cancellation one place to land. Only `confirmed` appointments ever send:
// the fire-time guard (`shouldSendReminder` in `notify-send.ts`) drops any
// job whose appointment left `confirmed`, and the API-side release sweep
// cancels `scheduled` rows that never confirmed.
//
// The 24h lead is instant math (`startsAt - 24h`), so it needs no timezone;
// the sede zone (`org_nodes.timezone`, Lima fallback) only decides how the
// instant reads in the patient-facing message (`formatInstantInTimezone`).
// The API mirrors `reminderJobId` / `reminderDelayMs` in
// `apps/api/src/notify/notify.service.ts` (same deliberate duplication as
// the template renderer); the three copies must stay byte-identical.

/**
 * Template `code` of the deferred 24h notice. Mirrors
 * `NOTIFY_TEMPLATE_APPOINTMENT_REMINDER_24H` in `packages/contracts` and
 * `apps/api/src/notify/notify.service.ts`.
 */
export const NOTIFY_REMINDER_TEMPLATE = 'appointment.reminder_24h' as const;

/** Lead time of the deferred notice: exactly 24 hours before the visit. */
export const REMINDER_LEAD_TIME_MS = 24 * 60 * 60 * 1000;

/** Fallback sede zone; mirrors migration 010 and the API `ORG_DEFAULT_TIMEZONE`. */
export const REMINDER_DEFAULT_TIMEZONE = 'America/Lima';

/**
 * Deterministic BullMQ job id of one appointment's deferred reminder.
 * Stable across reschedules, so reprogramming replaces the job instead of
 * doubling the notice, and cancelling needs only the appointment id.
 */
export function reminderJobId(appointmentId: string): string {
  return `appointment-reminder-24h:${appointmentId}`;
}

/**
 * Delay in milliseconds from `nowMs` until the reminder fire time
 * (`startsAt - 24h`), or `null` when no job should be scheduled: an
 * unparseable `startsAt`, or a fire time already reached/passed (the visit
 * is less than 24h away — there is nothing deferred left to schedule).
 * Pure instant math: the 24h lead is timezone-independent.
 */
export function reminderDelayMs(startsAtIso: string | null, nowMs: number): number | null {
  if (typeof startsAtIso !== 'string' || startsAtIso.trim() === '') return null;
  const startsAtMs = Date.parse(startsAtIso);
  if (Number.isNaN(startsAtMs)) return null;
  const delayMs = startsAtMs - REMINDER_LEAD_TIME_MS - nowMs;
  return delayMs > 0 ? delayMs : null;
}

/** ISO instant the reminder fires (`startsAt - 24h`), or `null` when unparseable. */
export function reminderFireAtIso(startsAtIso: string | null): string | null {
  if (typeof startsAtIso !== 'string' || startsAtIso.trim() === '') return null;
  const startsAtMs = Date.parse(startsAtIso);
  if (Number.isNaN(startsAtMs)) return null;
  return new Date(startsAtMs - REMINDER_LEAD_TIME_MS).toISOString();
}

/** True when `value` names a usable IANA timezone (backed by `Intl`). */
export function isUsableTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Usable zone or the Lima fallback (never throws). */
export function normalizeReminderTimezone(value: unknown): string {
  return isUsableTimezone(value) ? (value as string) : REMINDER_DEFAULT_TIMEZONE;
}

/**
 * Formats one UTC instant for the patient message in the sede zone
 * (`YYYY-MM-DD HH:mm`), so the notice reads sede time, never UTC.
 * Falls back to Lima on a bad instant or zone (never throws): a reminder
 * with a readable fallback time beats a crashed send.
 */
export function formatInstantInTimezone(iso: string | null, timezone: unknown): string {
  const zone = normalizeReminderTimezone(timezone);
  const time = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(time));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return new Date(time).toISOString();
  }
}
