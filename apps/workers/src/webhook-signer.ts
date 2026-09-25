// Webhook signing — HMAC-SHA256 over the exact payload bytes (W2).
//
// Pure and dependency-free (only `node:crypto`), so it loads under
// `node --test` without the `bullmq`/`ioredis` packages installed — the same
// split as `queues.ts`, which stays configuration-only while the BullMQ wiring
// lives in `webhook-deliver.ts`.
//
// Wire format: the worker POSTs the JSON payload with
// `x-webhook-signature: sha256=<hex>`, where `<hex>` is
// `HMAC-SHA256(secret, "<timestamp>.<body>")`. The timestamp (Unix-epoch
// seconds, `x-webhook-timestamp`) binds the signature to a moment so a
// captured delivery cannot be replayed forever; the receiver rejects anything
// older than its tolerance. `x-webhook-event` names the business event and
// `x-webhook-delivery` carries the delivery id for receiver-side idempotency.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header carrying the `sha256=<hex>` HMAC of the exact payload bytes. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/** Header carrying the Unix-epoch seconds the signature was built with. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';

/** Header echoing the business event (`invoice.issued`, ...). */
export const WEBHOOK_EVENT_HEADER = 'x-webhook-event';

/** Header carrying the delivery id for receiver-side idempotency. */
export const WEBHOOK_DELIVERY_HEADER = 'x-webhook-delivery';

/** Signature value prefix (`sha256=<hex>`); the algorithm is not negotiable. */
export const SIGNATURE_PREFIX = 'sha256=';

/** Default replay window in seconds (receivers should enforce their own). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Signed delivery headers the worker sends and the receiver verifies. */
export interface WebhookSignedHeaders {
  readonly signature: string;
  readonly timestamp: string;
  readonly event: string;
  readonly deliveryId: string;
}

/** Canonical signed message: timestamp, one dot, then the exact body bytes. */
export function buildSignedMessage(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** Hex HMAC-SHA256 of the canonical message under the subscription secret. */
export function signWebhookMessage(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(buildSignedMessage(timestamp, body), 'utf8').digest('hex');
}

/**
 * Builds the four delivery headers for one attempt. `body` must be the exact
 * string being POSTed — the signature covers bytes, not the parsed object, so
 * the caller serializes once and reuses the string for both.
 */
export function buildWebhookHeaders(options: {
  secret: string;
  event: string;
  deliveryId: string;
  body: string;
  timestamp?: string;
  nowSeconds?: number;
}): WebhookSignedHeaders {
  const timestamp = options.timestamp ?? String(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  return {
    signature: `${SIGNATURE_PREFIX}${signWebhookMessage(options.secret, timestamp, options.body)}`,
    timestamp,
    event: options.event,
    deliveryId: options.deliveryId,
  };
}

/**
 * Verifies one delivery: format (`sha256=<64 hex>`), freshness (inside the
 * tolerance window, no future skew beyond it) and the constant-time HMAC
 * comparison. Returns `false` for any malformed input — never throws, so a
 * hostile header cannot crash the receiver.
 */
export function verifyWebhookSignature(options: {
  secret: string;
  body: string;
  timestamp: string;
  signature: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const { secret, body } = options;
  const timestamp = options.timestamp.trim();
  const signature = options.signature.trim();
  if (secret === '' || body === '' || timestamp === '' || signature === '') return false;
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const presentedHex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(presentedHex)) return false;
  if (!/^\d+$/.test(timestamp)) return false;

  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const seen = Number(timestamp);
  if (!Number.isSafeInteger(seen) || Math.abs(now - seen) > tolerance) return false;

  const expected = signWebhookMessage(secret, timestamp, body);
  const a = Buffer.from(presentedHex, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
