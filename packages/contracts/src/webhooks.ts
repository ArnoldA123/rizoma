// Webhook contracts — `POST/GET /v1/webhooks/*` (W2, extended in W3).
//
// Signed business events with observable retries: a tenant admin registers a
// URL plus the events it wants, the API stores only the SHA-256 digest of the
// signing secret, and every delivery is signed HMAC-SHA256 so the receiver can
// verify the exact payload bytes. The first event set is billing
// (`invoice.issued|paid|voided`); W3 adds warehouse stock
// (`stock.posted|reversed`) and onboarding (`onboarding.closed`). Later tracks
// extend `webhookEventSchema` in the same work unit as their emitter — never a
// silent drift.
// Runner: `node --test src/webhooks.test.ts` (type stripping).
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';

/** Business events the outbox writer can emit (W2 billing, W3 stock + onboarding). */
export const webhookEventSchema = z.enum([
  'invoice.issued',
  'invoice.paid',
  'invoice.voided',
  'stock.posted',
  'stock.reversed',
  'onboarding.closed',
]);

export type WebhookEventName = z.infer<typeof webhookEventSchema>;

/** Delivery lifecycle the worker moves through (`queued → sent|failed`). */
export const webhookDeliveryStatusSchema = z.enum(['queued', 'sent', 'failed']);

export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;

/** Header carrying the `sha256=<hex>` HMAC of the exact payload bytes. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/** Header carrying the Unix-epoch seconds the signature was built with. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';

/** Header echoing the business event (`invoice.issued`, ...). */
export const WEBHOOK_EVENT_HEADER = 'x-webhook-event';

/** Header carrying the delivery id for receiver-side idempotency. */
export const WEBHOOK_DELIVERY_HEADER = 'x-webhook-delivery';

/** Public prefix of an issued signing secret (identification only). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** `POST /v1/webhooks/subscriptions` — subscribe a URL to business events. */
export const webhookSubscriptionCreateInputSchema = z.object({
  /** HTTPS endpoint the worker POSTs signed payloads to. */
  url: z.string().url().max(2000),
  /** Events to receive; at least one, no duplicates. */
  events: z.array(webhookEventSchema).min(1).refine((events) => new Set(events).size === events.length, {
    message: 'events must not contain duplicates',
  }),
});

export type WebhookSubscriptionCreateInput = z.input<typeof webhookSubscriptionCreateInputSchema>;

/** `PATCH /v1/webhooks/subscriptions/:id` — every field is optional. */
export const webhookSubscriptionUpdateInputSchema = z.object({
  url: z.string().url().max(2000).optional(),
  events: z
    .array(webhookEventSchema)
    .min(1)
    .refine((events) => new Set(events).size === events.length, {
      message: 'events must not contain duplicates',
    })
    .optional(),
  active: z.boolean().optional(),
});

export type WebhookSubscriptionUpdateInput = z.input<typeof webhookSubscriptionUpdateInputSchema>;

/** One subscription as the API lists it — digest only, never the secret. */
export const webhookSubscriptionRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  url: z.string(),
  events: z.array(webhookEventSchema),
  active: z.boolean(),
  createdAt: isoValueSchema,
});

export type WebhookSubscriptionRecord = z.infer<typeof webhookSubscriptionRecordSchema>;

/**
 * `POST /v1/webhooks/subscriptions` answer: the record plus the signing
 * secret, exactly once. Rotations return the same shape; list/update carry no
 * secret.
 */
export const webhookSubscriptionCreateResponseSchema = webhookSubscriptionRecordSchema.extend({
  /** Opaque signing secret (`whsec_...`); shown once, stored only as SHA-256. */
  secret: z.string().min(1),
});

export type WebhookSubscriptionCreateResponse = z.infer<typeof webhookSubscriptionCreateResponseSchema>;

/** `GET /v1/webhooks/subscriptions` — newest first, capped by the service. */
export const webhookSubscriptionListSchema = z.array(webhookSubscriptionRecordSchema);

export type WebhookSubscriptionList = z.infer<typeof webhookSubscriptionListSchema>;

/** One delivery as the read-only management endpoint returns it. */
export const webhookDeliveryRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  /** Owning subscription; `null` when the subscription was removed. */
  subscriptionId: uuidSchema.nullable(),
  event: webhookEventSchema,
  /** Denormalized target URL (frozen at enqueue time). */
  url: z.string(),
  status: webhookDeliveryStatusSchema,
  /** Attempts already made; the next delay follows `WEBHOOK=[60,...]`. */
  attempts: z.number(),
  /** When the worker may retry; `null` once delivered or exhausted. */
  nextRetryAt: isoValueSchema,
  createdAt: isoValueSchema,
});

export type WebhookDeliveryRecord = z.infer<typeof webhookDeliveryRecordSchema>;

/** `GET /v1/webhooks/deliveries` — newest first, capped by the service. */
export const webhookDeliveryListSchema = z.array(webhookDeliveryRecordSchema);

export type WebhookDeliveryList = z.infer<typeof webhookDeliveryListSchema>;
