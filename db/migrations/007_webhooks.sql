-- 007_webhooks.sql — W2: signed webhooks with observable retries.
-- Tenant webhook subscriptions (outbox writer target) plus the W2 columns of
-- the delivery outbox. The secret itself is never stored: `secret_hash` holds
-- the SHA-256 hex digest the worker uses to build the HMAC-SHA256 signature,
-- and the create/rotate endpoints return the clear secret exactly once.
--
-- Design notes:
--   * `webhook_subscriptions` is the new business table: tenant_id UUID NOT
--     NULL FK tenants(id) + RLS ENABLE/FORCE + POLICY tenant_isolation,
--     exactly like 001 (base §4.2) and 006. Indexes start with tenant_id
--     (base §4.3) and serve the per-tenant active-subscription lookup the
--     outbox writer runs inside the business transaction.
--   * `webhook_deliveries` already exists in 001 (tenant_id, event_id, url,
--     status, attempts, last_error, created_at) with its RLS policy, so this
--     migration only ADDS the W2 columns instead of recreating it: recreating
--     would silently no-op under IF NOT EXISTS and leave the F0 shape behind.
--     `subscription_id` links the delivery to its subscription, `event` names
--     the business event (`invoice.issued|paid|voided` first), `payload` is
--     the exact signed bytes (JSONB), and `next_retry_at` makes the
--     `WEBHOOK=[60,300,1800,7200,21600]` backoff observable per row.
--   * `url` stays denormalized on every delivery (copied from the
--     subscription at enqueue time, still NOT NULL per 001): a later URL edit
--     or subscription removal never rewrites history, and the worker needs no
--     join to deliver. `event_id` carries the business entity id (the invoice
--     id) for correlation with the audit log.
--   * The status check admits the legacy `pending` default from 001 plus the
--     W2 lifecycle `queued → sent|failed`: old rows stay readable, new rows
--     are written `queued` by the outbox writer and moved by the worker.
-- Idempotent: re-executable with IF NOT EXISTS / IF NOT EXISTS guards / DO blocks.
-- Requires 001 applied before (tenants, webhook_deliveries).

-- ============ webhook_subscriptions (business table: tenant + RLS) ============
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  url         TEXT NOT NULL CHECK (url <> ''),
  -- Hex SHA-256 of the signing secret. The secret itself is never stored.
  secret_hash TEXT NOT NULL CHECK (secret_hash <> ''),
  -- Business events this subscription receives (`invoice.issued`, ...).
  events      TEXT[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox writer lookup: active subscriptions of one tenant (tenant_id first, base §4.3).
CREATE INDEX IF NOT EXISTS ix_webhook_subscriptions_tenant_active
  ON webhook_subscriptions (tenant_id, active) WHERE active;
CREATE INDEX IF NOT EXISTS ix_webhook_subscriptions_tenant_created
  ON webhook_subscriptions (tenant_id, created_at DESC);

-- ============ webhook_deliveries: W2 columns on the 001 outbox ============
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES webhook_subscriptions(id);
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS event TEXT;
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}';
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Worker observability: due retries of one tenant, oldest first (tenant_id first, base §4.3).
CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_subscription_status
  ON webhook_deliveries (tenant_id, subscription_id, status);
CREATE INDEX IF NOT EXISTS ix_webhook_deliveries_next_retry
  ON webhook_deliveries (tenant_id, next_retry_at) WHERE status = 'queued';

-- W2 lifecycle on top of the 001 default: legacy `pending` rows stay valid,
-- new rows move `queued → sent` or back to `queued` with `next_retry_at` set
-- until attempts are exhausted (`failed`).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_status_check'
  ) THEN
    ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_status_check
      CHECK (status IN ('pending', 'queued', 'sent', 'failed'));
  END IF;
END $$;

-- ============ RLS (ENABLE + FORCE + policy, base §4.2, same NULLIF as 001) ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_subscriptions', 'webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
        AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I ' ||
        'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) ' ||
        'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
    END IF;
  END LOOP;
END $$;

-- ============ privileges ============
-- Same contract as 001/003/004/005/006 for the application role.
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY['webhook_subscriptions', 'webhook_deliveries'] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('007_webhooks')
ON CONFLICT (version) DO NOTHING;
