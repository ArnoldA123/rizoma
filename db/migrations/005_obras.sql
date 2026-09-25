-- 005_obras.sql — O1 MVP1 Obras: tablas del vertical construcción + RLS.
-- Fuentes normativas:
--   * docs/crm-maleable/bases-consolidadas-v1.md §2.4 (entidades, estados y
--     dependencias del vertical obras) y §3.4 (matriz de permisos obra)
--   * base §4.2 (RLS ENABLE + FORCE + policy tenant_isolation) y §4.3
--     (todo índice de negocio empieza por (tenant_id, ...))
--
-- Reglas aplicadas (idénticas a 001/002/003/004):
--   * toda tabla de negocio tiene tenant_id UUID NOT NULL FK tenants(id)
--   * RLS ENABLE + FORCE + POLICY tenant_isolation en cada tabla
--   * la conexión de negocio es rizoma_app, nunca un superusuario
-- No añade excepciones a la allowlist del linter (db/lint/rls_lint.sh): las 12
-- tablas de esta migración SÍ son tablas de negocio con tenant_id + policy.
--
-- Criterio de nulabilidad: NOT NULL por defecto; solo son NULLables las columnas
-- marcadas explícitamente en el alcance de O1 (sites.ended_at,
-- crews.lead_membership_id, assignments.crew_id, assignments.valid_to,
-- attendance.check_out, attendance.approved_by, assets.current_site_id,
-- stock_moves.site_id, budget_lines.item_id, progress_entries.budget_line_id).
--
-- Idempotente: re-ejecutable con IF NOT EXISTS / DO blocks.
-- Requiere 001 aplicada antes (tenants, org_nodes, users, memberships,
-- attachments).

-- ============ sites (obra/proyecto, §2.4) ============
-- Estados: planned → active → suspended → closing → closed / cancelled.
-- UNIQUE (tenant_id, code) es el folio legible de la obra dentro del tenant.
CREATE TABLE IF NOT EXISTS sites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  org_node_id  UUID NOT NULL REFERENCES org_nodes(id),  -- nodo 'obra' del árbol
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  client_name  TEXT NOT NULL,
  budget_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (budget_total >= 0),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'planned'
               CHECK (status IN ('planned','active','suspended','closing','closed','cancelled')),
  UNIQUE (tenant_id, code)
);

-- ============ crews (cuadrilla, §2.4) ============
-- El capataz se referencia por membership (el rol vive en la membership, no en
-- el usuario) y puede faltar mientras la cuadrilla no tiene líder asignado.
CREATE TABLE IF NOT EXISTS crews (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  org_node_id        UUID NOT NULL REFERENCES org_nodes(id),
  name               TEXT NOT NULL,
  lead_membership_id UUID REFERENCES memberships(id),
  active             BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============ assignments (asignación usuario↔obra/cuadrilla, §2.4) ============
-- El fin de la asignación es por `valid_to` o por `active = false`.
CREATE TABLE IF NOT EXISTS assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  user_id      UUID NOT NULL REFERENCES users(id),
  site_id      UUID NOT NULL REFERENCES sites(id),
  crew_id      UUID REFERENCES crews(id),
  role_in_site TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to     TIMESTAMPTZ
);

-- ============ attendance (asistencia, §2.4) ============
-- Estados: registered → approved / rejected / adjusted.
-- El momento de la marca es la fuente del dato; la aprobación es de terceros.
CREATE TABLE IF NOT EXISTS attendance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  site_id     UUID NOT NULL REFERENCES sites(id),
  check_in    TIMESTAMPTZ NOT NULL DEFAULT now(),
  check_out   TIMESTAMPTZ,
  source      TEXT NOT NULL DEFAULT 'web',
  status      TEXT NOT NULL DEFAULT 'registered'
              CHECK (status IN ('registered','approved','rejected','adjusted')),
  approved_by UUID REFERENCES users(id)
);

-- ============ assets (equipos/maquinaria, §2.4) ============
-- Estados: available → assigned → maintenance → retired.
-- UNIQUE (tenant_id, code) identifica el equipo dentro del tenant.
CREATE TABLE IF NOT EXISTS assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  org_node_id     UUID NOT NULL REFERENCES org_nodes(id),
  code            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  serial          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'available'
                  CHECK (status IN ('available','assigned','maintenance','retired')),
  current_site_id UUID REFERENCES sites(id),
  UNIQUE (tenant_id, code)
);

-- ============ asset_readings (horómetro / lecturas, §2.4) ============
-- Solo inserción en MVP1: la lectura manual del horómetro es un hecho fechado.
CREATE TABLE IF NOT EXISTS asset_readings (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  asset_id  UUID NOT NULL REFERENCES assets(id),
  kind      TEXT NOT NULL,
  value     NUMERIC NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  source    TEXT NOT NULL DEFAULT 'manual'
);

-- ============ inventory_items (ítem de almacén, §2.4) ============
CREATE TABLE IF NOT EXISTS inventory_items (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sku       TEXT NOT NULL,
  name      TEXT NOT NULL,
  unit      TEXT NOT NULL,
  min_stock NUMERIC NOT NULL DEFAULT 0,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (tenant_id, sku)
);

-- ============ stock_moves (movimiento de almacén, §2.4) ============
-- kind: in (ingreso a almacén) | out (consumo a obra) | transfer.
-- Estados: draft → posted → reversed.
CREATE TABLE IF NOT EXISTS stock_moves (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  item_id           UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_node_id UUID NOT NULL REFERENCES org_nodes(id),
  site_id           UUID REFERENCES sites(id),
  qty               NUMERIC NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('in','out','transfer')),
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','posted','reversed'))
);

-- ============ budget_lines (partida de presupuesto, §2.4) ============
-- `item_id` es NULLable: la partida puede describir un concepto sin ítem de
-- almacén asociado.
CREATE TABLE IF NOT EXISTS budget_lines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  site_id     UUID NOT NULL REFERENCES sites(id),
  item_id     UUID REFERENCES inventory_items(id),
  description TEXT NOT NULL,
  qty_planned NUMERIC NOT NULL DEFAULT 0,
  unit_cost   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============ progress_entries (avance de obra, §2.4) ============
-- Estados: draft → posted.
CREATE TABLE IF NOT EXISTS progress_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  site_id        UUID NOT NULL REFERENCES sites(id),
  budget_line_id UUID REFERENCES budget_lines(id),
  qty_done       NUMERIC NOT NULL DEFAULT 0,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_by    UUID NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','posted'))
);

-- ============ milestones (hito de obra, §2.4) ============
-- Estados: pending → done / late.
CREATE TABLE IF NOT EXISTS milestones (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  site_id   UUID NOT NULL REFERENCES sites(id),
  name      TEXT NOT NULL,
  due_at    TIMESTAMPTZ NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','done','late'))
);

-- ============ site_logs (bitácora de obra, §2.4) ============
-- Estados: draft → published. `attachment_ids` referencia `attachments.id`
-- (array de UUID, sin FK a nivel de fila).
CREATE TABLE IF NOT EXISTS site_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  site_id        UUID NOT NULL REFERENCES sites(id),
  author_id      UUID NOT NULL REFERENCES users(id),
  text           TEXT NOT NULL,
  attachment_ids UUID[] NOT NULL DEFAULT '{}',
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','published'))
);

-- ============ índices (siempre tenant_id primero, base §4.3) ============
CREATE INDEX IF NOT EXISTS ix_sites_tenant_org_status
  ON sites (tenant_id, org_node_id, status);
CREATE INDEX IF NOT EXISTS ix_crews_tenant_org
  ON crews (tenant_id, org_node_id, active);
CREATE INDEX IF NOT EXISTS ix_assignments_tenant_site
  ON assignments (tenant_id, site_id, active);
CREATE INDEX IF NOT EXISTS ix_assignments_tenant_user
  ON assignments (tenant_id, user_id, active);
CREATE INDEX IF NOT EXISTS ix_assignments_tenant_crew
  ON assignments (tenant_id, crew_id);
CREATE INDEX IF NOT EXISTS ix_attendance_tenant_site_checkin
  ON attendance (tenant_id, site_id, check_in DESC);
CREATE INDEX IF NOT EXISTS ix_attendance_tenant_user_checkin
  ON attendance (tenant_id, user_id, check_in DESC);
CREATE INDEX IF NOT EXISTS ix_assets_tenant_org_status
  ON assets (tenant_id, org_node_id, status);
CREATE INDEX IF NOT EXISTS ix_assets_tenant_current_site
  ON assets (tenant_id, current_site_id) WHERE current_site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_asset_readings_tenant_asset_at
  ON asset_readings (tenant_id, asset_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_inventory_items_tenant_active
  ON inventory_items (tenant_id, active);
CREATE INDEX IF NOT EXISTS ix_stock_moves_tenant_item_at
  ON stock_moves (tenant_id, item_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_stock_moves_tenant_site
  ON stock_moves (tenant_id, site_id);
CREATE INDEX IF NOT EXISTS ix_budget_lines_tenant_site
  ON budget_lines (tenant_id, site_id, active);
CREATE INDEX IF NOT EXISTS ix_budget_lines_tenant_item
  ON budget_lines (tenant_id, item_id);
CREATE INDEX IF NOT EXISTS ix_progress_entries_tenant_site_at
  ON progress_entries (tenant_id, site_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_progress_entries_tenant_budget_line
  ON progress_entries (tenant_id, budget_line_id);
CREATE INDEX IF NOT EXISTS ix_milestones_tenant_site_due
  ON milestones (tenant_id, site_id, due_at);
CREATE INDEX IF NOT EXISTS ix_site_logs_tenant_site_at
  ON site_logs (tenant_id, site_id, at DESC);

-- ============ RLS (ENABLE + FORCE + policy por tabla, base §4.2) ============
-- Misma expresión NULLIF que 001/002/003/004: sin app.tenant_id no se ve
-- ninguna fila.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sites','crews','assignments','attendance','assets','asset_readings',
    'inventory_items','stock_moves','budget_lines','progress_entries',
    'milestones','site_logs'
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
-- Tablas de negocio: mismo contrato que 001/002/003/004 para el rol de
-- aplicación. (001 ya declaró ALTER DEFAULT PRIVILEGES para rizoma_app; el
-- GRANT explícito lo materializa aunque la migración la aplique otro rol.)
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'sites','crews','assignments','attendance','assets','asset_readings',
      'inventory_items','stock_moves','budget_lines','progress_entries',
      'milestones','site_logs'
    ] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('005_obras')
ON CONFLICT (version) DO NOTHING;
