-- 006_api_keys.sql — W1: tenant API keys (machine auth over `X-Api-Key`).
-- Machine clients authenticate without a Keycloak JWT: the opaque secret travels
-- in the `X-Api-Key` header, the API stores only its SHA-256 hex digest
-- (`key_hash`) and compares digests — the secret in clear never touches disk.
--
-- Design notes:
--   * Business table: tenant_id UUID NOT NULL FK tenants(id) + RLS
--     ENABLE/FORCE + POLICY tenant_isolation, exactly like 001 (base §4.2).
--     No allowlist exception is added to db/lint/rls_lint.sh.
--   * Indexes: `ix_api_keys_tenant_created` starts with tenant_id (base §4.3)
--     and serves the management list. `key_hash` carries a deliberate GLOBAL
--     UNIQUE instead of a tenant-first key: the verifier must resolve the
--     tenant FROM the secret alone, before any tenant context exists, so a
--     `(tenant_id, key_hash)` key could not serve that lookup. Secrets are
--     256-bit random, so cross-tenant collision is not a practical concern.
--   * `verify_api_key(TEXT)` is SECURITY DEFINER on purpose: the request-time
--     lookup runs before `app.tenant_id` is set, when RLS would hide every row
--     from `rizoma_app`. The function compares digests only, enforces
--     `active` + the validity window, and returns tenant/scopes — never the
--     hash. EXECUTE is granted to `rizoma_app` alone.
--   * Revocation is a plain `active = false` (or an expired window): the
--     middleware resolves the key on EVERY request (no permission cache, same
--     contract as memberships in `auth/access.guard.ts`), so a revocation is
--     effective on the next request.
-- Idempotent: re-executable with IF NOT EXISTS / DO blocks.
-- Requires 001 applied before (tenants).

-- ============ api_keys (business table: tenant + RLS) ============
CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL CHECK (name <> ''),
  -- Hex SHA-256 of the opaque secret. The secret itself is never stored.
  key_hash    TEXT NOT NULL UNIQUE CHECK (key_hash <> ''),
  -- Short public identifier (first bytes of the secret, hex) so the list shows
  -- operators WHICH key is which without ever exposing the secret.
  key_prefix  TEXT NOT NULL CHECK (key_prefix <> ''),
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- List endpoint: keys of one tenant, newest first (tenant_id first, base §4.3).
CREATE INDEX IF NOT EXISTS ix_api_keys_tenant_created
  ON api_keys (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_api_keys_tenant_active
  ON api_keys (tenant_id, active) WHERE active;

-- ============ RLS (ENABLE + FORCE + policy, base §4.2, same NULLIF as 001) ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys'] LOOP
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

-- ============ verify_api_key (pre-tenant lookup, SECURITY DEFINER) ============
-- Runs as the table owner so it sees past RLS: at lookup time the request has
-- no `app.tenant_id` yet, and under FORCE RLS the app role would see zero rows.
-- Compares the presented digest, enforces revocation + window, and returns the
-- tenant and scopes the middleware feeds into `set_config`. Returns zero rows
-- for an unknown, revoked or out-of-window key — the caller answers 401.
CREATE OR REPLACE FUNCTION verify_api_key(p_key_hash TEXT)
RETURNS TABLE (key_id UUID, tenant_id UUID, scopes TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT k.id, k.tenant_id, k.scopes
  FROM api_keys k
  WHERE k.key_hash = p_key_hash
    AND k.active
    AND k.valid_from <= now()
    AND (k.valid_to IS NULL OR k.valid_to > now());
END;
$$;
REVOKE ALL ON FUNCTION verify_api_key(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_api_key(TEXT) TO rizoma_app;

-- ============ privileges ============
-- Same contract as 001/003/004/005 for the application role. (001 already
-- declared ALTER DEFAULT PRIVILEGES for rizoma_app; the explicit GRANT
-- materializes it even when another role applies this migration.)
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY['api_keys'] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('006_api_keys')
ON CONFLICT (version) DO NOTHING;
