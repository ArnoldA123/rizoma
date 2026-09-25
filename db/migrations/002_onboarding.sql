-- 002_onboarding.sql — F0/T4: onboarding de primer arranque (anexo Perú §11).
-- Disparo: base vacía (cero tenants) o app_state sin 'initialized_at'. El
-- wizard corre una sola vez y no se reabre con un tenant ya inicializado.
--
-- Excepciones RLS documentadas (allowlist explícita en db/lint/rls_lint.sh):
--   * app_state        -> singleton global del arranque (clave/valor JSONB).
--                         No pertenece a ningún tenant: es la marca previa a la
--                         existencia de tenants, así que no lleva tenant_id ni
--                         RLS. Acceso solo del rol de setup (conexión admin).
--   * onboarding_cases -> datos pre-tenant del alta: mientras se recorre el
--                         wizard el tenant todavía no existe. Sin tenant_id ni
--                         RLS; acceso solo del rol de setup. La protección
--                         multi-tenant empieza en onboarding_acta.
--   * onboarding_acta  -> SÍ es tabla de negocio: tenant_id NOT NULL FK
--                         tenants + RLS ENABLE/FORCE + policy tenant_isolation,
--                         igual que 001. Además es append-only (§11: acta
--                         firmada, versionada e inmutable).
-- Idempotente: re-ejecutable con IF NOT EXISTS / DO blocks.
-- Requiere 001 aplicada antes (onboarding_acta referencia tenants).

-- ============ app_state (singleton global, sin RLS — excepción documentada) ============
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ============ onboarding_cases (pre-tenant, sin RLS — excepción documentada) ============
CREATE TABLE IF NOT EXISTS onboarding_cases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT UNIQUE NOT NULL,
  current_step    INT NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 7),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','closed')),
  organizer       JSONB,
  sites           JSONB,
  identity        JSONB,
  billing         JSONB,
  admin_user      JSONB,
  acta_hash       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_onboarding_cases_status
  ON onboarding_cases (status, current_step);
CREATE INDEX IF NOT EXISTS ix_onboarding_cases_idempotency
  ON onboarding_cases (idempotency_key);

-- ============ onboarding_acta (tabla de negocio: tenant + RLS) ============
CREATE TABLE IF NOT EXISTS onboarding_acta (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  case_id    UUID NOT NULL,
  hash       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices: tenant_id primero (base §4.3).
CREATE INDEX IF NOT EXISTS ix_onboarding_acta_tenant_case
  ON onboarding_acta (tenant_id, case_id);
CREATE INDEX IF NOT EXISTS ix_onboarding_acta_tenant_created
  ON onboarding_acta (tenant_id, created_at DESC);

-- RLS ENABLE + FORCE + policy tenant_isolation (base §4.2), igual que 001.
ALTER TABLE onboarding_acta ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_acta FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'onboarding_acta' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON onboarding_acta
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

-- Append-only: el acta del alta no se modifica ni se borra nunca (§11).
REVOKE UPDATE, DELETE ON onboarding_acta FROM PUBLIC;
CREATE OR REPLACE FUNCTION onboarding_acta_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'onboarding_acta is append-only';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'onboarding_acta_no_change') THEN
    CREATE TRIGGER onboarding_acta_no_change
    BEFORE UPDATE OR DELETE ON onboarding_acta
    FOR EACH ROW EXECUTE FUNCTION onboarding_acta_block_change();
  END IF;
END $$;

-- ============ privilegios ============
-- onboarding_acta: tabla de negocio, el rol de aplicación la usa como el resto
-- (la inmutabilidad la garantiza el trigger, no la ausencia de GRANT).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_acta TO rizoma_app';
  END IF;
END $$;

-- app_state y onboarding_cases: datos pre-tenant, solo el rol de setup los toca.
-- 001 deja ALTER DEFAULT PRIVILEGES a favor de rizoma_app, que aplicaría a estas
-- tablas nuevas; el REVOKE explícito materializa la excepción documentada.
-- El flujo de alta corre por la conexión admin directa (localhost:5432), igual
-- que las migraciones (db/README.md).
REVOKE ALL ON app_state, onboarding_cases FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    EXECUTE 'REVOKE ALL ON app_state, onboarding_cases FROM rizoma_app';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('002_onboarding')
ON CONFLICT (version) DO NOTHING;
