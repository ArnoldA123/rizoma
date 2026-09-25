-- 001_core_foundation.sql — F0 Fundación: tablas core + RLS por tenant.
-- Reglas (bases-consolidadas-v1.md §4.1-§4.3):
--   * toda tabla de negocio tiene tenant_id UUID NOT NULL FK tenants(id)
--   * RLS ENABLE + FORCE + POLICY tenant_isolation en cada tabla de negocio
--   * todo índice de negocio empieza por (tenant_id, ...)
-- Excepciones documentadas: tenants (es la raíz, sin tenant_id) y
-- schema_migrations (control interno). El linter db/lint/rls_lint.sh las
-- tiene en allowlist explícita.
-- Idempotente: re-ejecutable con IF NOT EXISTS / DO blocks.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version  TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ tenants (raíz, sin tenant_id) ============
CREATE TABLE IF NOT EXISTS tenants (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL,
  plan      TEXT NOT NULL DEFAULT 'base',
  isolated  BOOLEAN NOT NULL DEFAULT FALSE,
  country   CHAR(2) NOT NULL DEFAULT 'PE',
  locale    TEXT NOT NULL DEFAULT 'es-PE',
  theme     JSONB NOT NULL DEFAULT '{}',
  modules   TEXT[] NOT NULL DEFAULT '{crm-core}',
  status    TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','suspended','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ tablas de negocio (todas con tenant_id) ============

CREATE TABLE IF NOT EXISTS org_nodes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  parent_id  UUID REFERENCES org_nodes(id),
  kind       TEXT NOT NULL
             CHECK (kind IN ('empresa','sede','sucursal','area','proyecto','obra','especialidad')),
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  mfa_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  code        TEXT NOT NULL,
  vertical    TEXT NOT NULL DEFAULT 'transversal',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('draft','active','retired')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  org_node_id UUID NOT NULL REFERENCES org_nodes(id),
  role        TEXT NOT NULL,
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_bindings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  role_id     UUID NOT NULL REFERENCES roles(id),
  org_node_id UUID NOT NULL REFERENCES org_nodes(id),
  permissions TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  actor       UUID,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   UUID,
  org_node_id UUID REFERENCES org_nodes(id),
  diff        JSONB NOT NULL DEFAULT '{}',
  ip          TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only: ningún rol de aplicación puede modificar ni borrar auditoría.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
CREATE OR REPLACE FUNCTION audit_log_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_change') THEN
    CREATE TRIGGER audit_log_no_change
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_change();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  aggregate    TEXT NOT NULL,
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}',
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','dispatched','failed'))
);

CREATE TABLE IF NOT EXISTS documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  owner_type      TEXT NOT NULL,
  owner_id        UUID NOT NULL,
  bucket_key      TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  retention_until DATE,
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('quarantined','available','expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  document_id UUID REFERENCES documents(id),
  bucket_key  TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL DEFAULT 0,
  uploaded_by UUID REFERENCES users(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response     JSONB,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  metric    TEXT NOT NULL,
  period    TEXT NOT NULL,
  qty       NUMERIC NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE (tenant_id, metric, period)
);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  metric          TEXT NOT NULL,
  qty             NUMERIC NOT NULL DEFAULT 0,
  source_event_id UUID,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  channel      TEXT NOT NULL,
  template     TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','delivered','failed')),
  cost         NUMERIC NOT NULL DEFAULT 0,
  provider_ref TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notify_templates (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  channel   TEXT NOT NULL,
  code      TEXT NOT NULL,
  version   INT NOT NULL DEFAULT 1,
  body      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','active','retired')),
  UNIQUE (tenant_id, channel, code, version)
);

CREATE TABLE IF NOT EXISTS custom_field_defs (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  module    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  code      TEXT NOT NULL,
  type      TEXT NOT NULL,
  required  BOOLEAN NOT NULL DEFAULT FALSE,
  status    TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','active','retired')),
  UNIQUE (tenant_id, module, entity, code)
);

CREATE TABLE IF NOT EXISTS saved_views (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id   UUID REFERENCES users(id),
  entity    TEXT NOT NULL,
  filters   JSONB NOT NULL DEFAULT '{}',
  shared    BOOLEAN NOT NULL DEFAULT FALSE,
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  kind           TEXT NOT NULL,
  file_id        UUID REFERENCES attachments(id),
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','completed','failed')),
  rows_ok        INT NOT NULL DEFAULT 0,
  rows_error     INT NOT NULL DEFAULT 0,
  errors_file_id UUID REFERENCES attachments(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  event_id   UUID NOT NULL,
  url        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tablas mínimas F2 (campo/IoT): se crean vacías en fundación.
CREATE TABLE IF NOT EXISTS devices (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  code      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind      TEXT NOT NULL,
  payload   JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  org_node_id UUID NOT NULL REFERENCES org_nodes(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS checkins (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  visit_id  UUID REFERENCES visits(id),
  user_id   UUID NOT NULL REFERENCES users(id),
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source    TEXT NOT NULL DEFAULT 'web',
  status    TEXT NOT NULL DEFAULT 'registered'
);

-- ============ índices (siempre tenant_id primero, base §4.3) ============
CREATE INDEX IF NOT EXISTS ix_org_nodes_tenant_parent ON org_nodes (tenant_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_users_tenant_active ON users (tenant_id, active) WHERE active;
CREATE INDEX IF NOT EXISTS ix_memberships_tenant_user ON memberships (tenant_id, user_id) WHERE active;
CREATE INDEX IF NOT EXISTS ix_memberships_tenant_org ON memberships (tenant_id, org_node_id, active);
CREATE INDEX IF NOT EXISTS ix_audit_log_tenant_at ON audit_log (tenant_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_log_tenant_entity ON audit_log (tenant_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_outbox_tenant_status ON outbox (tenant_id, status, occurred_at);
CREATE INDEX IF NOT EXISTS ix_documents_tenant_owner ON documents (tenant_id, owner_type, owner_id);
CREATE INDEX IF NOT EXISTS ix_attachments_tenant_doc ON attachments (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS ix_usage_metrics_tenant_at ON usage_metrics (tenant_id, metric, at DESC);
CREATE INDEX IF NOT EXISTS ix_message_log_tenant_status ON message_log (tenant_id, status, at DESC);
CREATE INDEX IF NOT EXISTS ix_import_jobs_tenant_status ON import_jobs (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_webhook_tenant_status ON webhook_deliveries (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_telemetry_tenant_device ON telemetry_events (tenant_id, device_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_visits_tenant_org ON visits (tenant_id, org_node_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_checkins_tenant_user ON checkins (tenant_id, user_id, at DESC);

-- ============ RLS (ENABLE + FORCE + policy por tabla, base §4.2) ============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_nodes','users','roles','memberships','role_bindings','audit_log',
    'outbox','documents','attachments','idempotency_keys','usage_counters',
    'usage_metrics','message_log','notify_templates','custom_field_defs',
    'saved_views','import_jobs','webhook_deliveries','devices',
    'telemetry_events','visits','checkins'
  ] LOOP
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

-- Rol de aplicación: sin SUPERUSER para que RLS aplique siempre.
-- (Los superusuarios burlan RLS incluso con FORCE; la app nunca usa superusuario.)
-- Clave demo solo local: en compartidos/producción la credencial vive en el vault.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    CREATE ROLE rizoma_app NOSUPERUSER LOGIN PASSWORD 'rizoma_demo_password';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO rizoma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rizoma_app;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['rizoma', 'rizoma_app', 'postgres'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public ' ||
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rizoma_app', r);
    END IF;
  END LOOP;
END $$;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO rizoma_app', current_database());
END $$;

INSERT INTO schema_migrations (version) VALUES ('001_core_foundation')
ON CONFLICT (version) DO NOTHING;
