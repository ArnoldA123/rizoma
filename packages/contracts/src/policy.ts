// Policy preview contracts — read-only audit mirror of `apps/api/src/policy/`
// (B5) over three things the code already decides:
//
//   - the role × action matrix (`apps/api/src/auth/policy.ts`);
//   - the salud board gates (`BOARD_ACTIONS` in `dashboards.service.ts`);
//   - the closed `state_transitions` catalog (migration 009, B3).
//
// Convention follows the rest of the package: camelCase keys as the API emits
// them, closed `z.enum` catalogs for the vocabularies the code owns (`role`
// stays a free string on the query because deny-by-default is itself a fact
// worth previewing — an unknown role answers 200 with everything denied).
// There is no logic builder here: the endpoint only exposes what the code
// already decides, for audit.
import { z } from 'zod';

/** The 14 realm roles declared in `infra/keycloak/realm-rizoma.json`. */
export const POLICY_ROLES = [
  'ti_admin',
  'direccion',
  'medico',
  'enfermeria',
  'recepcion',
  'caja',
  'auditor',
  'gerente',
  'jefe_obra',
  'almacen',
  'capataz',
  'trabajador',
  'vendedor',
  'soporte',
] as const;

export const policyRoleSchema = z.enum(POLICY_ROLES);
export type PolicyRole = z.infer<typeof policyRoleSchema>;

/** Actions the demo matrix arbitrates — identical list to `policy.ts`. */
export const POLICY_ACTIONS = [
  'agenda.read',
  'patient.read',
  'patient.write',
  'episode.write',
  'appointment.write',
  'invoice.issue',
  'attendance.mark',
  'attendance.approve',
  'stock.consume',
  'site.read',
  'site.write',
  'assignment.write',
] as const;

export const policyActionSchema = z.enum(POLICY_ACTIONS);
export type PolicyAction = z.infer<typeof policyActionSchema>;

/** Entities the 009 catalog covers (CHECK of `state_transitions`). */
export const POLICY_PREVIEW_ENTITIES = ['episode', 'attendance', 'site_log'] as const;

export const policyPreviewEntitySchema = z.enum(POLICY_PREVIEW_ENTITIES);
export type PolicyPreviewEntity = z.infer<typeof policyPreviewEntitySchema>;

/**
 * Board gate mirror: board → action, the same mapping as `BOARD_ACTIONS` in
 * `apps/api/src/salud/dashboards.service.ts` (`recepcion` and `medico` open
 * on `agenda.read`, `caja` on `invoice.issue`). The API additionally requires
 * the caller to *be* the board role; the preview reports only the action
 * term, which is the auditable half.
 */
export const POLICY_BOARD_ACTIONS = {
  recepcion: 'agenda.read',
  caja: 'invoice.issue',
  medico: 'agenda.read',
} as const satisfies Record<string, PolicyAction>;

/** Boards the salud vertical exposes. */
export const POLICY_BOARDS = Object.keys(POLICY_BOARD_ACTIONS) as unknown as Readonly<
  ['recepcion', 'caja', 'medico']
>;

/**
 * Action each catalog entity is enforced with, alongside the catalog row
 * itself: episodes close on `episode.write` (`salud.service.ts`), attendance
 * approves on `attendance.approve` (`obras.service.ts`), site logs publish on
 * `attendance.mark` (`resources.service.ts`). A transition therefore allows
 * only when the catalog grants the role AND the matrix grants the action.
 */
export const POLICY_TRANSITION_ACTIONS = {
  episode: 'episode.write',
  attendance: 'attendance.approve',
  site_log: 'attendance.mark',
} as const satisfies Record<PolicyPreviewEntity, PolicyAction>;

/** Query of `GET /v1/policy/preview`. */
export const policyPreviewQuerySchema = z.object({
  role: z.string().min(1),
  entity: policyPreviewEntitySchema,
  estado: z.string().min(1),
});

export type PolicyPreviewQuery = z.infer<typeof policyPreviewQuerySchema>;

/** One catalog move out of `estado`, with the verdict for the queried role. */
export const policyPreviewTransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Action the endpoint enforces alongside the catalog row. */
  action: policyActionSchema,
  /** The role is listed in the catalog row's `allowed_roles`. */
  roleListed: z.boolean(),
  /** The matrix grants the role the transition action. */
  rolePermits: z.boolean(),
  /** Effective verdict: listed AND permitted. */
  allowed: z.boolean(),
});

export type PolicyPreviewTransition = z.infer<typeof policyPreviewTransitionSchema>;

/** One salud board, with the action term for the queried role. */
export const policyPreviewBoardSchema = z.object({
  board: z.string(),
  action: policyActionSchema,
  allowed: z.boolean(),
});

export type PolicyPreviewBoard = z.infer<typeof policyPreviewBoardSchema>;

/** `GET /v1/policy/preview` — what the role may do in the given state. */
export const policyPreviewSchema = z.object({
  role: z.string(),
  entity: policyPreviewEntitySchema,
  estado: z.string(),
  permittedActions: z.array(policyActionSchema),
  deniedActions: z.array(policyActionSchema),
  transitions: z.array(policyPreviewTransitionSchema),
  boards: z.array(policyPreviewBoardSchema),
});

export type PolicyPreview = z.infer<typeof policyPreviewSchema>;

/**
 * Query string of `GET /v1/policy/preview`, `?` included (`role`, then
 * `entity`, then `estado`, the order the controller reads them).
 */
export function policyPreviewQueryString(query: PolicyPreviewQuery): string {
  const parts = [
    `role=${encodeURIComponent(query.role)}`,
    `entity=${encodeURIComponent(query.entity)}`,
    `estado=${encodeURIComponent(query.estado)}`,
  ];
  return `?${parts.join('&')}`;
}
