-- 009_state_transitions.sql — B3: closed configurable state transitions.
--
-- Today every entity validates its states by hand (`stateAllows` + direct
-- SQL in `salud.service.ts`, `obras.service.ts`, `resources.service.ts`).
-- This migration adds the closed catalog those call-sites consult through
-- `assertTransition` (`apps/api/src/state-transitions/`): a transition that
-- is not listed here is denied, and a listed one additionally gates on the
-- caller's membership role (`allowed_roles`).
--
-- RLS DECISION (documented per B3): per-tenant table WITH `tenant_id` and the
-- standard `tenant_isolation` policy — NOT a global read-only catalog.
-- Reasons:
--   1. `db/lint/rls_lint.sh` requires `tenant_id` + a `tenant_isolation`
--      policy on every business table, and its allowlist is frozen for this
--      task. A global table without `tenant_id` would fail `db:lint` with no
--      in-scope fix.
--   2. Uniformity with every other business table (base §4.2): the request
--      transaction already binds `app.tenant_id`, and every service query
--      carries `tenant_id` explicitly.
--   3. "Configurable" leaves room for per-tenant divergence later without a
--      new migration; today the seed backfills the same closed set for every
--      existing tenant.
-- Rejected alternative: a global catalog without `tenant_id` (single seed,
-- permissive read policy). Revisit only if transitions become truly global;
-- it needs an allowlist entry in `db/lint/rls_lint.sh` first.
--
-- SCOPE (B3): seed carries ONLY the tested transitions —
--   episodes   open → closed / cancelled
--   attendance registered → approved / rejected / adjusted
--   site_log   draft → published
-- Out of scope: an arbitrary machine, appointments/sites (contract/DB
-- divergence still pending), and every other entity state in 003/005.
--
-- `allowed_roles` mirrors the policy matrix in force today
-- (`apps/api/src/auth/policy.ts`), so the catalog agrees with the legacy
-- checks it now sits beside:
--   episodes   `episode.write`      → medico
--   attendance `attendance.approve` → gerente, jefe_obra, capataz
--   site_log   `attendance.mark`    → gerente, jefe_obra, almacen,
--                                     capataz, trabajador
-- Idempotent: re-executable with IF NOT EXISTS / DO blocks / ON CONFLICT.

-- ============ state_transitions (closed catalog, per tenant) ============
CREATE TABLE IF NOT EXISTS state_transitions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  entity        TEXT NOT NULL
                CHECK (entity IN ('episode', 'attendance', 'site_log')),
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  allowed_roles TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, from_status, to_status)
);

-- Tenant-first lookup key (base §4.3): the exact predicate `assertTransition`
-- binds. The UNIQUE constraint above already maintains this index; the
-- statement keeps the migration self-describing under IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS ix_state_transitions_tenant_entity
  ON state_transitions (tenant_id, entity, from_status, to_status);

-- ============ seed: the tested transitions, backfilled per tenant ============
-- One row per (tenant × transition); re-runnable via ON CONFLICT DO NOTHING.
INSERT INTO state_transitions (tenant_id, entity, from_status, to_status, allowed_roles)
SELECT t.id, v.entity, v.from_status, v.to_status, v.allowed_roles
FROM tenants t
CROSS JOIN (VALUES
  ('episode',    'open',       'closed',    ARRAY['medico']),
  ('episode',    'open',       'cancelled', ARRAY['medico']),
  ('attendance', 'registered', 'approved',  ARRAY['gerente', 'jefe_obra', 'capataz']),
  ('attendance', 'registered', 'rejected',  ARRAY['gerente', 'jefe_obra', 'capataz']),
  ('attendance', 'registered', 'adjusted',  ARRAY['gerente', 'jefe_obra', 'capataz']),
  ('site_log',   'draft',      'published', ARRAY['gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador'])
) AS v(entity, from_status, to_status, allowed_roles)
ON CONFLICT (tenant_id, entity, from_status, to_status) DO NOTHING;

-- ============ RLS (ENABLE + FORCE + policy, base §4.2, same NULLIF as 001) ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['state_transitions'] LOOP
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
-- Same contract as 001/003/004/005/006/007/008 for the application role.
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY['state_transitions'] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('009_state_transitions')
ON CONFLICT (version) DO NOTHING;
