-- 010_org_nodes_timezone.sql — P4-1a: sede-local day (timezone IANA per sede).
--
-- Every board resolves "today" in the sede's zone instead of UTC, so the API
-- needs one IANA timezone per org node. The column is a plain TEXT with a
-- NOT NULL DEFAULT: existing rows are covered by the default (no destructive
-- backfill) and IANA validity is enforced in the service/contract layer
-- (`isValidIanaTimezone`), not with a DB CHECK, so a future tzdata rename
-- never blocks a migration.
--
-- RLS: no policy change — the column lives on the already-isolated
-- `org_nodes` table (`tenant_id` + `tenant_isolation` from 001).

ALTER TABLE IF EXISTS org_nodes
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Lima';

COMMENT ON COLUMN org_nodes.timezone IS
  'P4-1a: IANA timezone of the sede (e.g. America/Lima); boards resolve "today" in this zone.';
