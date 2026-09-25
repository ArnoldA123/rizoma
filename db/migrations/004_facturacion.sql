-- 004_facturacion.sql — S4 MVP1 Salud: caja y facturación Perú
-- (quotes, invoices, payments, invoice_counters) + RLS.
-- Fuentes normativas:
--   * docs/crm-maleable/bases-consolidadas-v1.md §2.5 (quotes, invoices,
--     payments: estados comerciales y fiscales separados)
--   * docs/crm-maleable/peru-anexo-v1.md §3 (PEN con 2 decimales, IGV 18 %
--     parametrizable, serie + correlativo sin huecos, factura manual
--     borrador→emitida→anulada con motivo, switch manual/SUNAT por tenant)
--   * base §4.2 (RLS ENABLE + FORCE + policy tenant_isolation) y §4.3
--     (todo índice de negocio empieza por (tenant_id, ...))
--
-- Reglas aplicadas (idénticas a 001/002/003):
--   * toda tabla de negocio tiene tenant_id UUID NOT NULL FK tenants(id)
--   * RLS ENABLE + FORCE + POLICY tenant_isolation en cada tabla
--   * la conexión de negocio es rizoma_app, nunca un superusuario
-- No añade excepciones a la allowlist del linter (db/lint/rls_lint.sh): las 4
-- tablas de esta migración SÍ son tablas de negocio con tenant_id + policy.
--
-- Criterio de nulabilidad: NOT NULL por defecto; solo son NULLables las columnas
-- marcadas explícitamente (invoices.quote_id, invoices.cash_session_id,
-- invoices.issued_at, payments.external_ref, cash_sessions.closed_at en 003).
--
-- Nota de diseño (ampliación deliberada del alcance literal): `invoices` lleva
-- `customer_name` además del par documento, porque el comprobante manual de
-- peru-anexo §3.2 identifica al adquiriente por nombre y documento; sin ese
-- campo la factura no es imprimible ni auditable.
--
-- Idempotente: re-ejecutable con IF NOT EXISTS / DO blocks.
-- Requiere 001 aplicada antes (tenants, org_nodes, users) y 003 (cash_sessions).

-- ============ quotes (cotización, base §2.5) ============
-- Estados: draft → sent → accepted / rejected / expired.
CREATE TABLE IF NOT EXISTS quotes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  org_node_id   UUID NOT NULL REFERENCES org_nodes(id),  -- sede
  customer_name TEXT NOT NULL,
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  total         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ invoices (comprobante, base §2.5 + peru-anexo §3) ============
-- Dos ejes independientes:
--   * comercial: draft → issued → paid / partially_paid / voided
--   * fiscal:    pending → sent → accepted / rejected / contingency
-- `serie` + `numero` es el folio del tenant; el UNIQUE hace imposible un hueco
-- duplicado aunque la reserva falle. `fiscal_payload` guarda el payload crudo
-- inmutable para auditoría y replay (base §5.3).
CREATE TABLE IF NOT EXISTS invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  org_node_id         UUID NOT NULL REFERENCES org_nodes(id),  -- sede
  quote_id            UUID REFERENCES quotes(id),
  serie               TEXT NOT NULL,
  numero              INT NOT NULL CHECK (numero > 0),
  customer_doc_type   TEXT NOT NULL,   -- dni | ce | pasaporte | ruc
  customer_doc_number TEXT NOT NULL,
  customer_name       TEXT NOT NULL,
  items               JSONB NOT NULL DEFAULT '[]'::jsonb,
  subtotal            NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  igv_rate            NUMERIC(5,4) NOT NULL DEFAULT 0.18 CHECK (igv_rate >= 0),
  igv_total           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (igv_total >= 0),
  total               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','issued','paid','partially_paid','voided')),
  fiscal_status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (fiscal_status IN ('pending','sent','accepted','rejected','contingency')),
  fiscal_adapter      TEXT NOT NULL DEFAULT 'manual_v1',
  fiscal_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  cash_session_id     UUID REFERENCES cash_sessions(id),
  issued_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serie, numero)
);

-- ============ payments (cobro, base §2.5) ============
-- Estados: registered → reconciled / reversed.
CREATE TABLE IF NOT EXISTS payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  invoice_id   UUID NOT NULL REFERENCES invoices(id),
  method       TEXT NOT NULL,
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  status       TEXT NOT NULL DEFAULT 'registered'
               CHECK (status IN ('registered','reconciled','reversed')),
  external_ref TEXT,
  paid_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ invoice_counters (reserva de folio sin huecos, peru-anexo §3.3) ============
-- Un contador por (tenant, serie). La emisión lo bloquea con
-- `SELECT ... FOR UPDATE` y luego incrementa: dos emisiones concurrentes de la
-- misma serie se serializan en vez de colisionar, y ningún número se salta.
CREATE TABLE IF NOT EXISTS invoice_counters (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  serie       TEXT NOT NULL,
  last_number INT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY (tenant_id, serie)
);

-- ============ índices (siempre tenant_id primero, base §4.3) ============
CREATE INDEX IF NOT EXISTS ix_quotes_tenant_org
  ON quotes (tenant_id, org_node_id, status);
CREATE INDEX IF NOT EXISTS ix_invoices_tenant_org
  ON invoices (tenant_id, org_node_id, status);
CREATE INDEX IF NOT EXISTS ix_invoices_tenant_quote
  ON invoices (tenant_id, quote_id);
CREATE INDEX IF NOT EXISTS ix_invoices_tenant_cash_session
  ON invoices (tenant_id, cash_session_id);
CREATE INDEX IF NOT EXISTS ix_invoices_tenant_fiscal
  ON invoices (tenant_id, fiscal_status);
CREATE INDEX IF NOT EXISTS ix_payments_tenant_invoice
  ON payments (tenant_id, invoice_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS ix_invoice_counters_tenant_serie
  ON invoice_counters (tenant_id, serie);

-- ============ RLS (ENABLE + FORCE + policy por tabla, base §4.2) ============
-- Misma expresión NULLIF que 001: sin app.tenant_id no se ve ninguna fila.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quotes','invoices','payments','invoice_counters'
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
-- Tablas de negocio: mismo contrato que 001/002/003 para el rol de aplicación.
DO $$
DECLARE t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rizoma_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'quotes','invoices','payments','invoice_counters'
    ] LOOP
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rizoma_app', t);
    END LOOP;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('004_facturacion')
ON CONFLICT (version) DO NOTHING;
