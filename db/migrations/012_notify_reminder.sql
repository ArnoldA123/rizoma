-- 012_notify_reminder.sql — P4-3: 24h reminder template + lookup index.
--
-- Seeds the deferred-reminder template every tenant needs before the salud
-- emitter can schedule a 24h notice: one `active` version per channel
-- (`email`, `sms`) for code `appointment.reminder_24h`, backfilled per tenant
-- like the 011 transition seed (no versioned catalog-seed mechanism exists
-- for `notify_templates`; `db/seeds/` holds per-vertical demo data only).
--
-- Slots (rendered at send time from the job payload, never stored):
--   {{appointmentId}}, {{patientId}}, {{startsAt}} (UTC instant),
--   {{startsAtLocal}} (the same instant formatted in the sede timezone —
--   `org_nodes.timezone`, Lima fallback — so the patient reads sede time).
--
-- The index covers the operator lookup the release sweep and the reminder
-- relay run (`tenant + template + status + at`); plain CREATE INDEX, no table
-- rewrite. Idempotent: re-executable with ON CONFLICT / IF NOT EXISTS.

-- ============ 1. reminder template, one active version per channel ============
INSERT INTO notify_templates (tenant_id, channel, code, version, body, status)
SELECT t.id, v.channel, 'appointment.reminder_24h', 1, v.body, 'active'
FROM tenants t
CROSS JOIN (VALUES
  ('email', 'Reminder: you have an appointment on {{startsAtLocal}} (appointment {{appointmentId}}).'),
  ('sms', 'Rizoma: your appointment is on {{startsAtLocal}} ({{appointmentId}}).')
) AS v(channel, body)
ON CONFLICT (tenant_id, channel, code, version) DO NOTHING;

-- ============ 2. operator lookup index (no rewrite, additive only) ============
CREATE INDEX IF NOT EXISTS ix_message_log_tenant_template_status_at
  ON message_log (tenant_id, template, status, at);

INSERT INTO schema_migrations (version) VALUES ('012_notify_reminder')
ON CONFLICT (version) DO NOTHING;
