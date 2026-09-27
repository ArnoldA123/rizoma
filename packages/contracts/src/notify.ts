// Notify contracts — `POST/GET /v1/notify/*` (N1).
//
// Tenant notifications over `message_log` + `notify_templates`
// (`db/migrations/001_core_foundation.sql`): the API enqueues one `queued`
// row per notification inside the emitter transaction and a worker moves it
// through `queued → sent → delivered|failed`. Template bodies render with a
// simple `{{var}}` interpolation at send time.
//
// SQL mapping note: the public contract names the destination field `to`
// (recipient address: email, phone or chat handle). The real SQL column is
// `recipient` (there is no `to` column in `message_log`); the service maps
// `to` (contract) → `recipient` (SQL) on every write and documents it here
// so the drift never leaks into the wire shape.
// Runner: `node --test src/notify.test.ts` (type stripping).
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';

/** Channels the notify service can enqueue (`message_log.channel`). */
export const notifyChannelSchema = z.enum(['email', 'sms', 'whatsapp']);

export type NotifyChannel = z.infer<typeof notifyChannelSchema>;

/** Delivery lifecycle the worker moves through (`message_log.status`). */
export const notifyStatusSchema = z.enum(['queued', 'sent', 'delivered', 'failed']);

export type NotifyStatus = z.infer<typeof notifyStatusSchema>;

/** Template lifecycle (`notify_templates.status`). */
export const notifyTemplateStatusSchema = z.enum(['draft', 'active', 'retired']);

/**
 * Template `code` the billing emitter enqueues on `invoice.issued`
 * (channel `email`). Mirrored in `apps/api/src/notify/notify.service.ts`.
 */
export const NOTIFY_TEMPLATE_INVOICE_ISSUED = 'invoice.issued' as const;

/**
 * Template `code` the salud emitter enqueues when an appointment is
 * scheduled (channel `email` when the patient has an email, `sms` when only
 * a phone is on file). Mirrored in `apps/api/src/notify/notify.service.ts`.
 */
export const NOTIFY_TEMPLATE_APPOINTMENT_SCHEDULED = 'appointment.scheduled' as const;

/**
 * Template `code` the salud emitter schedules as a deferred 24h notice
 * (one BullMQ delayed job per confirmed appointment, deterministic job id
 * `appointment-reminder-24h:<appointmentId>`). One `active` version per
 * channel (`email`, `sms`), seeded per tenant by migration 012. Mirrored in
 * `apps/api/src/notify/notify.service.ts` and
 * `apps/workers/src/queues.ts` (`NOTIFY_REMINDER_TEMPLATE`).
 */
export const NOTIFY_TEMPLATE_APPOINTMENT_REMINDER_24H = 'appointment.reminder_24h' as const;

export type NotifyTemplateStatus = z.infer<typeof notifyTemplateStatusSchema>;

/**
 * Payload the deferred 24h reminder carries on its BullMQ job (P4-3).
 * Rendered into the `{{appointmentId}}`, `{{patientId}}` and `{{startsAt}}`
 * slots of the active `appointment.reminder_24h` template at send time;
 * the worker additionally derives `{{startsAtLocal}}` (the same instant in
 * the sede timezone) before rendering. `message_log` stores no body, so
 * this payload is transient — it travels on the job, never on the row.
 */
export const appointmentReminderPayloadSchema = z.object({
  /** Appointment the reminder was scheduled for. */
  appointmentId: uuidSchema,
  /** Patient the appointment belongs to. */
  patientId: uuidSchema,
  /** Appointment start (UTC instant); the fire time is `startsAt - 24h`. */
  startsAt: isoValueSchema,
});

export type AppointmentReminderPayload = z.infer<typeof appointmentReminderPayloadSchema>;

/** `POST /v1/notify/send` — enqueue one notification for the caller tenant. */
export const notifySendInputSchema = z.object({
  /** Channel to enqueue on. */
  channel: notifyChannelSchema,
  /** Active template `code` looked up in `notify_templates`. */
  template: z.string().trim().min(1).max(120),
  /** Destination address (email, phone or chat handle); stored as `recipient`. */
  to: z.string().trim().min(1).max(320),
  /** Variables rendered into the `{{var}}` slots of the template body. */
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type NotifySendInput = z.infer<typeof notifySendInputSchema>;

/** One `message_log` row as the API returns it (`to` = SQL `recipient`). */
export const notifyMessageRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  channel: notifyChannelSchema,
  /** Template `code` the row was enqueued with. */
  template: z.string(),
  /** Destination address; persisted in the SQL `recipient` column. */
  to: z.string(),
  status: notifyStatusSchema,
  /** Accumulated provider cost. */
  cost: z.number(),
  /** Provider-side reference; `null` until the worker reports one. */
  providerRef: z.string().nullable(),
  createdAt: isoValueSchema,
});

export type NotifyMessageRecord = z.infer<typeof notifyMessageRecordSchema>;

/** `GET /v1/notify/messages` — newest first, capped by the service. */
export const notifyMessageListSchema = z.array(notifyMessageRecordSchema);

export type NotifyMessageList = z.infer<typeof notifyMessageListSchema>;

/** One `notify_templates` row as the API returns it. */
export const notifyTemplateRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  channel: notifyChannelSchema,
  /** Template code referenced by `NotifySendInput.template`. */
  code: z.string(),
  version: z.number(),
  body: z.string(),
  status: notifyTemplateStatusSchema,
});

export type NotifyTemplateRecord = z.infer<typeof notifyTemplateRecordSchema>;

/** `POST /v1/notify/templates` — register one template version. */
export const notifyTemplateCreateInputSchema = z.object({
  channel: notifyChannelSchema,
  code: z.string().trim().min(1).max(120),
  /** Body with `{{var}}` slots rendered from the send payload. */
  body: z.string().trim().min(1).max(8000),
  /** Version to store; defaults to 1. */
  version: z.number().int().min(1).default(1),
  /** Lifecycle state; defaults to `draft`. */
  status: notifyTemplateStatusSchema.default('draft'),
});

export type NotifyTemplateCreateInput = z.infer<typeof notifyTemplateCreateInputSchema>;

/** `GET /v1/notify/templates` — active templates first, capped by the service. */
export const notifyTemplateListSchema = z.array(notifyTemplateRecordSchema);

export type NotifyTemplateList = z.infer<typeof notifyTemplateListSchema>;
