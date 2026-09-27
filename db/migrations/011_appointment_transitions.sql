-- 011_appointment_transitions.sql — P4-2a: appointment machine + derived state.
--
-- Closes the drift the P4-0 scout recorded: migration 003 declares seven
-- appointment states
-- (`scheduled, confirmed, checked_in, in_care, completed, no_show, cancelled`)
-- while `packages/contracts` mirrored five with `done` instead of `completed`,
-- and migration 009 deliberately left appointments out of scope. This file:
--   1. adds the terminal `derived` state to the `appointments.status` CHECK
--      (a derivation is a state, not a new table: `audit_log` already traces
--      who/when per the P4 decision);
--   2. widens the `state_transitions.entity` CHECK to `appointment` and
--      `prescription` and seeds the closed appointment machine
--        scheduled → confirmed / cancelled / derived
--        confirmed → checked_in / no_show / cancelled
--        checked_in → in_care
--        in_care → completed
--      plus the prescription close-out (`draft → issued / cancelled`);
--   3. leaves rescheduling out of the catalog on purpose: a reschedule keeps
--      the status and only moves `starts_at` (allowed from `scheduled` or
--      `confirmed`), so there is no (from, to) triple to seed.
--
-- `allowed_roles` mirrors the policy matrix in force
-- (`apps/api/src/auth/policy.ts`): `recepcion` owns the desk moves
-- (`appointment.write`), `medico` owns the clinical moves on its own agenda
-- (`appointment.attend`, own `professional_id`) and every prescription move
-- (`episode.write`). `caja` appears nowhere, denied as today.
-- Idempotent: re-executable with IF NOT EXISTS / DO blocks / ON CONFLICT.

-- ============ 1. appointments.status gains `derived` ============
-- The CHECK was declared inline in 003, so Postgres named it
-- `appointments_status_check`; drop by that name when present and re-add the
-- eight-state version. Existing rows already satisfy the wider CHECK, so no
-- backfill runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_status_check'
  ) THEN
    ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
  END IF;
END $$;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('scheduled', 'confirmed', 'checked_in',
                    'in_care', 'completed', 'no_show', 'cancelled', 'derived'));

-- ============ 2. catalog entities gain `appointment`, `prescription` ============
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'state_transitions_entity_check'
  ) THEN
    ALTER TABLE state_transitions DROP CONSTRAINT state_transitions_entity_check;
  END IF;
END $$;

ALTER TABLE state_transitions
  ADD CONSTRAINT state_transitions_entity_check
  CHECK (entity IN ('episode', 'attendance', 'site_log', 'appointment', 'prescription'));

-- ============ 3. seed: the P4-2a transitions, backfilled per tenant ============
-- One row per (tenant × transition); re-runnable via ON CONFLICT DO NOTHING.
INSERT INTO state_transitions (tenant_id, entity, from_status, to_status, allowed_roles)
SELECT t.id, v.entity, v.from_status, v.to_status, v.allowed_roles
FROM tenants t
CROSS JOIN (VALUES
  ('appointment',  'scheduled',  'confirmed', ARRAY['recepcion', 'medico']),
  ('appointment',  'scheduled',  'cancelled', ARRAY['recepcion', 'medico']),
  ('appointment',  'scheduled',  'derived',   ARRAY['medico']),
  ('appointment',  'confirmed',  'checked_in', ARRAY['recepcion', 'medico']),
  ('appointment',  'confirmed',  'no_show',   ARRAY['recepcion', 'medico']),
  ('appointment',  'confirmed',  'cancelled', ARRAY['recepcion', 'medico']),
  ('appointment',  'checked_in', 'in_care',   ARRAY['medico']),
  ('appointment',  'in_care',    'completed', ARRAY['medico']),
  ('prescription', 'draft',      'issued',    ARRAY['medico']),
  ('prescription', 'draft',      'cancelled', ARRAY['medico'])
) AS v(entity, from_status, to_status, allowed_roles)
ON CONFLICT (tenant_id, entity, from_status, to_status) DO NOTHING;

-- RLS and privileges ride on the existing `state_transitions` table (009):
-- no new table, no new policy, no new grant.

INSERT INTO schema_migrations (version) VALUES ('011_appointment_transitions')
ON CONFLICT (version) DO NOTHING;
