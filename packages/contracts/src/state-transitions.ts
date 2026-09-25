// State-transition contracts — Zod mirror of `state_transitions`
// (migration 009, B3) and of the closed seed it carries.
//
// Convention follows the rest of the package: camelCase keys as the API emits
// them, a plain `z.enum` for the closed catalogs (the table owns the machine,
// this module only mirrors the seeded values so screens and tests can name
// them), `string | null` for the optional timestamp. The seed mirror
// (`SEEDED_STATE_TRANSITIONS`) exists so the contract suite pins the exact
// six rows the migration backfills — a seventh row in either place fails the
// suite instead of drifting silently.
//
// Scope (B3): episodes open→closed/cancelled, attendance
// registered→approved/rejected/adjusted, site_log draft→published. No
// arbitrary machine, no appointments/sites.
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';

/** Entities the 009 catalog covers (CHECK of `state_transitions`). */
export const STATE_TRANSITION_ENTITIES = ['episode', 'attendance', 'site_log'] as const;

export const stateTransitionEntitySchema = z.enum(STATE_TRANSITION_ENTITIES);
export type StateTransitionEntity = z.infer<typeof stateTransitionEntitySchema>;

/** Seeded `episode` moves: `open` is the only source state. */
export const EPISODE_TRANSITIONS = [
  { from: 'open', to: 'closed' },
  { from: 'open', to: 'cancelled' },
] as const;

/** Seeded `attendance` moves out of `registered`. */
export const ATTENDANCE_TRANSITIONS = [
  { from: 'registered', to: 'approved' },
  { from: 'registered', to: 'rejected' },
  { from: 'registered', to: 'adjusted' },
] as const;

/** Seeded `site_log` move: `draft` is the only source state. */
export const SITE_LOG_TRANSITIONS = [{ from: 'draft', to: 'published' }] as const;

/** Roles granted per seeded transition (policy matrix mirror, B3). */
export const EPISODE_TRANSITION_ROLES = ['medico'] as const;
export const ATTENDANCE_TRANSITION_ROLES = ['gerente', 'jefe_obra', 'capataz'] as const;
export const SITE_LOG_TRANSITION_ROLES = [
  'gerente',
  'jefe_obra',
  'almacen',
  'capataz',
  'trabajador',
] as const;

/** One seeded catalog row, exactly as migration 009 backfills it per tenant. */
export interface SeededStateTransition {
  readonly entity: StateTransitionEntity;
  readonly from: string;
  readonly to: string;
  readonly allowedRoles: readonly string[];
}

/** The six seeded rows — the whole closed machine until B3 grows it. */
export const SEEDED_STATE_TRANSITIONS: readonly SeededStateTransition[] = [
  { entity: 'episode', from: 'open', to: 'closed', allowedRoles: [...EPISODE_TRANSITION_ROLES] },
  { entity: 'episode', from: 'open', to: 'cancelled', allowedRoles: [...EPISODE_TRANSITION_ROLES] },
  {
    entity: 'attendance',
    from: 'registered',
    to: 'approved',
    allowedRoles: [...ATTENDANCE_TRANSITION_ROLES],
  },
  {
    entity: 'attendance',
    from: 'registered',
    to: 'rejected',
    allowedRoles: [...ATTENDANCE_TRANSITION_ROLES],
  },
  {
    entity: 'attendance',
    from: 'registered',
    to: 'adjusted',
    allowedRoles: [...ATTENDANCE_TRANSITION_ROLES],
  },
  {
    entity: 'site_log',
    from: 'draft',
    to: 'published',
    allowedRoles: [...SITE_LOG_TRANSITION_ROLES],
  },
];

/** One `state_transitions` row, as the API reads it. */
export const stateTransitionRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  entity: stateTransitionEntitySchema,
  fromStatus: z.string(),
  toStatus: z.string(),
  allowedRoles: z.array(z.string()),
  createdAt: isoValueSchema,
});

export type StateTransitionRecord = z.infer<typeof stateTransitionRecordSchema>;

/** `GET` of the catalog — one entry per listed transition of the tenant. */
export const stateTransitionListSchema = z.array(stateTransitionRecordSchema);
export type StateTransitionList = z.infer<typeof stateTransitionListSchema>;

/**
 * Input of `assertTransition` (`apps/api/src/state-transitions/`): the
 * attempted move and the membership role attempting it. `entity` stays closed
 * (appointments/sites are out of scope); `from`/`to`/`role` are free strings
 * because the table — not the contract — owns their vocabularies.
 */
export const assertTransitionInputSchema = z.object({
  entity: stateTransitionEntitySchema,
  from: z.string().min(1),
  to: z.string().min(1),
  role: z.string().min(1),
});

export type AssertTransitionInput = z.infer<typeof assertTransitionInputSchema>;
