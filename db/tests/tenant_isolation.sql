-- Prueba de aislamiento entre 2 tenants (criterio de salida F0 #1).
-- Se ejecuta como rol app (SET ROLE) porque los superusuarios burlan RLS.
-- Cualquier fuga o visibilidad sin tenant dispara RAISE EXCEPTION.
SET ROLE rizoma_app;
DO $$
DECLARE
  a UUID := '00000000-0000-0000-0000-000000000001';
  b UUID := '00000000-0000-0000-0000-000000000002';
  n INT;
BEGIN
  INSERT INTO tenants (id, name) VALUES (a, 'Tenant A demo'), (b, 'Tenant B demo')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('app.tenant_id', a::text, false);
  INSERT INTO org_nodes (tenant_id, kind, name)
  SELECT a, 'empresa', 'Empresa A demo'
  WHERE NOT EXISTS (SELECT 1 FROM org_nodes WHERE tenant_id = a);

  PERFORM set_config('app.tenant_id', b::text, false);
  INSERT INTO org_nodes (tenant_id, kind, name)
  SELECT b, 'empresa', 'Empresa B demo'
  WHERE NOT EXISTS (SELECT 1 FROM org_nodes WHERE tenant_id = b);

  PERFORM set_config('app.tenant_id', b::text, false);
  SELECT count(*) INTO n FROM org_nodes;
  IF n <> 1 THEN RAISE EXCEPTION 'FUGA: tenant B ve % filas, esperaba 1', n; END IF;

  PERFORM set_config('app.tenant_id', a::text, false);
  SELECT count(*) INTO n FROM org_nodes;
  IF n <> 1 THEN RAISE EXCEPTION 'FUGA: tenant A ve % filas, esperaba 1', n; END IF;

  PERFORM set_config('app.tenant_id', '', false);
  SELECT count(*) INTO n FROM org_nodes;
  IF n <> 0 THEN RAISE EXCEPTION 'FUGA: sin tenant se ven % filas', n; END IF;

  RAISE NOTICE 'ISOLATION OK: A=1, B=1, sin-tenant=0';
END $$;
RESET ROLE;
