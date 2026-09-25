-- 003_salud.sql — S1 MVP1 Salud: tablas clínicas del vertical salud + RLS.
-- Fuentes normativas:
--   * docs/crm-maleable/bases-consolidadas-v1.md §2.3 (entidades del vertical)
--   * docs/crm-maleable/peru-anexo-v1.md §2 (consentimiento teleinterconsulta)
--   * base §4.2 (RLS ENABLE + FORCE + policy tenant_isolation) y §4.3
--     (todo índice de negocio empieza por (tenant_id, ...))
--
-- Reglas aplicadas (idénticas a 001/002):
--   * toda tabla de negocio tiene tenant_id UUID NOT NULL FK tenants(id)
--   * RLS ENABLE + FORCE + POLICY tenant_isolation en cada tabla
--   * ningún rol superusuario usa la app: la conexión de negocio es rizoma_app
-- No añade excepciones a la allowlist del linter (db/lint/rls_lint.sh): las 7
-- tablas de esta migración SÍ son tablas de negocio con tenant_id + policy.
--
-- Criterio de nulabilidad: NOT NULL por defecto; solo son NULLables las columnas
-- marcadas explícitamente como tales en el alcance de S1 (closed_at, signed_at,
-- evidence_attachment_id, triages.episode_id).
--
-- Idempotente: re-ejecutable con IF NOT EXISTS / DO blocks.
-- Requiere 001 aplicada antes (tenants, org_nodes, users, attachments).

-- ============ patient_files (ficha del paciente, §2.3) ============
-- El documento se guarda inline (split por tipo + número) porque en MVP1 no
-- existe aún la tabla `persons` del diseño global; la unicidad por tenant
-- evita duplicar pacientes con el mismo documento.
CREATE TABLE IF NOT EXISTS patient_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  org_node_id     UUID NOT NULL REFERENCES org_nodes(id),  -- sede
  person_name     TEXT NOT NULL,
  document_type   TEXT NOT NULL,                           -- dni | ce | pasaporte
  document_number TEXT NOT NULL,
  birthdate       DATE,
  allergies       TEXT[] NOT NULL DEFAULT '{}',
  alerts          TEXT[] NOT NULL DEFAULT '{}',
  contacts        JSONB NOT NULL DEFAULT '{}'::jsonb,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_number)
);

-- ============ episodes (episodio clínico, §2.3) ============
CREATE TABLE IF NOT EXISTS episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  patient_id      UUID NOT NULL REFERENCES patient_files(id),
  specialty       TEXT NOT NULL,
  professional_id UUID NOT NULL REFERENCES users(id),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed','cancelled'))
);

-- ============ appointments (agenda por sede, §2.3) ============
CREATE TABLE IF NOT EXISTS appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  org_node_id     UUID NOT NULL REFERENCES org_nodes(id),  -- sede
  patient_id      UUID NOT NULL REFERENCES patient_files(id),
  professional_id UUID NOT NULL REFERENCES users(id),
  starts_at       TIMESTAMPTZ NOT NULL,
  duration_min    INT NOT NULL CHECK (duration_min > 0),
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','confirmed','checked_in',
                                    'in_care','completed','no_show','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ triages (signos vitales / triaje, §2.3) ============
-- Solo inserción en el dominio: la corrección es una nueva versión (no se
-- implementa aún el bloqueo de UPDATE/DELETE; ver riesgos en el informe).
CREATE TABLE IF NOT EXISTS triages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  patient_id  UUID NOT NULL REFERENCES patient_files(id),
  episode_id  UUID REFERENCES episodes(id),
  recorded_by UUID NOT NULL REFERENCES users(id),
  values      JSONB NOT NULL DEFAULT '{}'::jsonb,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ consents (consentimiento informado, peru-anexo §2.2) ============
-- Reutiliza el modelo base `consents`; para teleinterconsulta:
-- template_code = 'consent.pe.teleinterconsulta'. La evidencia firmada apunta a
-- un attachment con sha256 y retención propia (nunca se borra físicamente).
CREATE TABLE IF NOT EXISTS consents (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id),
  patient_id             UUID NOT NULL REFERENCES patient_files(id),
  template_code          TEXT NOT NULL,
  version                TEXT NOT NULL,
  signed_at              TIMESTAMPTZ,
  evidence_attachment_id UUID REFERENCES attachments(id),
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','signed','revoked','expired'))
);

-- ============ prescriptions (receta por plantilla, §2.3) ============
CREATE TABLE IF NOT EXISTS prescriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  patient_id    UUID NOT NULL REFERENCES patient_files(id),
  episode_id    UUID NOT NULL REFERENCES episodes(id),
  template_code TEXT NOT NULL,
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','issued','cancelled'))
);

-- ============ cash_sessions (turno de caja, §2.3) ============
CREATE TABLE IF NOT EXISTS cash_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  org_node_id UUID NOT NULL REFERENCES org_nodes(id),  -- sede
  opened_by   UUID NOT NULL REFERENCES users(id),
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  totals      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','closed'))
);

-- ============ índices (siempre tenant_id primero, base §4.3) ============
-- patient_files: búsqueda de paciente por documento (el UNIQUE cubre
-- (tenant_id, document_number); este índice añade el tipo de documento).
CREATE INDEX IF NOT EXISTS ix_patient_files_tenant_document
  ON patient_files (tenant_id, document_type, document_number);
CREATE INDEX IF NOT EXISTS ix_patient_files_tenant_org
  ON patient_files (tenant_id, org_node_id, active);
-- appointments: agenda de sede por fecha y agenda por profesional.
CREATE INDEX IF NOT EXISTS ix_appointments_tenant_org_start
  ON appointments (tenant_id, org_node_id, starts_at);
CREATE INDEX IF NOT EXISTS ix_appointments_tenant_professional_start
  ON appointments (tenant_id, professional_id, starts_at);
-- episodes: historial del paciente.
CREATE INDEX IF NOT EXISTS ix_episodes_tenant_patient
  ON episodes (tenant_id, patient_id, opened_at DESC);
-- triages: última toma del paciente.
CREATE INDEX IF NOT EXISTS ix_triages_tenant_patient_at
  ON triages (tenant_id, patient_id, at DESC);
-- consents: consentimiento vigente por paciente + plantilla.
CREATE INDEX IF NOT EXISTS ix_consents_tenant_patient_template
  ON consents (tenant_id, patient_id, template_code);
-- prescriptions: recetas del episodio.
CREATE INDEX IF NOT EXISTS ix_prescriptions_tenant_episode
  ON prescriptions (tenant_id, episode_id);
-- cash_sessions: turno abierto/cerrado por sede.
CREATE INDEX IF NOT EXISTS ix_cash_sessions_tenant_org_status
  ON cash_sessions (tenant_id, org_node_id, status);

-- ============ RLS (ENABLE + FORCE + policy por tabla, base §4.2) ============
-- Misma expresión NULLIF que 001: sin app.tenant_id no se ve ninguna fila.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patient_files','episodes','appointments','triages','consents',
    'prescriptions','cash_sessions'
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

-- ============ privilegios ============
-- Tablas de negocio: mismo contrato que 001/002 para el rol de aplicación.
-- (001 ya declaró ALTER DEFAULT PRIVILEGES para rizoma_app; el GRANT explícito
-- lo materializa aunque la migración la aplique otro rol.)
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'patient_files','episodes','appointments','triages','consents',
      'prescriptions','cash_sessions'
    ] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('003_salud')
ON CONFLICT (version) DO NOTHING;
