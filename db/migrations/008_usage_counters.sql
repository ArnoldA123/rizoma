-- 008_usage_counters.sql — W3: per-API-key usage counters (hourly windows).
-- Counts machine calls answered 2xx so tenant operators can observe API-key
-- consumption per endpoint. The writer is best-effort and never fails the
-- business request: `recordApiKeyUsage` in
-- `apps/api/src/webhooks/usage-counters.ts` runs after the response, inside no
-- business transaction.
--
-- Design notes:
--   * `usage_counters` already exists in 001 (`id`, `tenant_id`, `metric`,
--     `period`, `qty`, `status`) with its RLS policy, so this migration only
--     ADDS the W3 columns instead of recreating it — same precedent as 007,
--     which extended `webhook_deliveries` instead of recreating it.
--     `api_key_id` references 006 (`api_keys`) and stays NULL-able: counting
--     only fires for `X-Api-Key` calls today, but the column leaves room for
--     counting other identity sources later without a new migration.
--   * `endpoint` is the normalized `METHOD /path` the API served (query string
--     stripped, capped by the writer); `window_start` truncates the served
--     instant to the UTC hour, so one row counts one (tenant, key, endpoint,
--     hour). `count` starts at 1 and the writer bumps it with a single
--     `INSERT ... ON CONFLICT DO UPDATE` statement.
--   * Uniqueness is a plain tenant-first key (base §4.3): the writer only ever
--     binds a real key id (it returns early otherwise), so the NULL-ability of
--     `api_key_id` never meets the arbiter. The legacy 001 key
--     `UNIQUE (tenant_id, metric, period)` is retired below: it would reject
--     the second endpoint counted in the same hour. The writer still binds
--     `metric = 'api.calls'` / `period = <hour ISO>` so the NOT NULL columns
--     keep their meaning (counter family + hour bucket).
-- Idempotent: re-executable with IF NOT EXISTS / IF NOT EXISTS guards / DO blocks.
-- Requires 001 (usage_counters) and 006 (api_keys) applied before.

-- ============ usage_counters: W3 columns on the 001 table ============
ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS api_key_id UUID REFERENCES api_keys(id);
ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS endpoint TEXT;
ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ;
ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS count BIGINT NOT NULL DEFAULT 0;

-- Counter upsert lookup: one row per (tenant, key, endpoint, hour),
-- tenant_id first (base §4.3). Also serves the per-key consumption reads.
CREATE UNIQUE INDEX IF NOT EXISTS ix_usage_counters_api_window
  ON usage_counters (tenant_id, api_key_id, endpoint, window_start);
CREATE INDEX IF NOT EXISTS ix_usage_counters_tenant_window
  ON usage_counters (tenant_id, window_start DESC);

-- Retire the 001 counting key: one row per (tenant, key, endpoint, hour) now
-- lives under `ix_usage_counters_api_window` below. The constraint name is
-- resolved from the catalog (never guessed), so the block is a safe no-op
-- once retired or on a database that never had it.
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'usage_counters'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE '%(tenant_id, metric, period)%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE usage_counters DROP CONSTRAINT %I', c);
  END IF;
END $$;

-- ============ RLS (ENABLE + FORCE + policy, base §4.2, same NULLIF as 001) ============
-- `usage_counters` already carries the policy from 001; the block re-asserts
-- it so 008 stays self-sufficient under the 006/007 pattern (IF NOT EXISTS
-- guards make it a no-op on a migrated database).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['usage_counters'] LOOP
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
-- Same contract as 001/003/004/005/006/007 for the application role.
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY['usage_counters'] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('008_usage_counters')
ON CONFLICT (version) DO NOTHING;
