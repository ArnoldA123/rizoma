// Role × action permission matrix for the demo verticals
// (bases-consolidadas-v1.md §3.3 clinical, §3.4 construction).
//
// Boundary: this module owns only the `role.permits(action)` term of the formal
// rule in §3.1. Scope (subtree), entity state and tenant module activation are
// decided elsewhere (the guard and the endpoint layer), so
// {@link rolePermitsAction} stays a pure predicate over two codes — no I/O, no
// clock, no container.
//
// Deny by default (§3.1 property 1): an unknown role or an unknown action
// returns `false`, and a known role merely does not appear in a grant. The
// normative extracts translate into the following load-bearing facts:
// - `auditor` is read-only, so it appears only on read actions.
// - `caja` issues invoices but never reads clinical history or the agenda.
// - `recepcion` reads the agenda, registers the patient file and schedules
//   appointments, but cannot open a clinical history.
// - `medico` reads patients and the agenda, writes the patient file and the
//   episode (the only role that edits a diagnosis, §3.3), but never sees
//   amounts/invoices.
// - `enfermeria` reads the clinical history as a non-writer: the §3.3 extract
//   grants its history access as `(sede, lectura)` and denies editing an
//   episode, so no clinical write is granted here.
// - `trabajador` marks only their own attendance: no approvals, no stock, and
//   sees only the site they are actively assigned to (the assignment, not the
//   role, is the access key — enforced by `obras/obras.service.ts`).
// - `almacen` marks attendance and consumes stock, but never approves.
// - `gerente` creates and edits a site and assigns workers (`site.write`,
//   `assignment.write`); `jefe_obra` assigns inside its own sites but never
//   creates a site; every construction role reads the site it can reach
//   (`site.read`).
// - `auditor` is read-only here too: `site.read` and nothing that writes.
// - `vendedor`/`soporte` are transversal and have no grant in this demo matrix.
//
// This matrix is intentionally minimal (the twelve actions MVP1 exercises); it
// is not the full §3.3/§3.4 table and it is not a cache: see
// `PERMISSION_CACHE_TTL_MS` in `./access.guard.ts` for the revocation contract.

/** Actions the demo matrix arbitrates. */
export const ACTION_CODES = [
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

export type ActionCode = (typeof ACTION_CODES)[number];

/** The 14 realm roles declared in `infra/keycloak/realm-rizoma.json`. */
export const ROLE_CODES = [
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

export type RoleCode = (typeof ROLE_CODES)[number];

/** Small builder that keeps the matrix literal readable. */
function grants(...actions: ActionCode[]): Set<ActionCode> {
  return new Set(actions);
}

/**
 * Role → granted actions. Every {@link RoleCode} has an entry, so a role that
 * is absent from an action is denied by omission rather than by a missing key.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, Set<ActionCode>> = {
  // Salud (§3.3).
  ti_admin: grants('agenda.read'),
  direccion: grants('agenda.read'),
  medico: grants('agenda.read', 'patient.read', 'patient.write', 'episode.write'),
  enfermeria: grants('agenda.read', 'patient.read'),
  recepcion: grants('agenda.read', 'patient.write', 'appointment.write'),
  caja: grants('invoice.issue'),
  auditor: grants('agenda.read', 'site.read'),
  // Construcción (§3.4): gerente works at company scope, jefe_obra at its own
  // sites, almacen at its warehouses; capataz approves its crew, trabajador
  // only marks its own attendance and reads the site it is assigned to.
  gerente: grants(
    'attendance.mark',
    'attendance.approve',
    'stock.consume',
    'site.read',
    'site.write',
    'assignment.write',
  ),
  jefe_obra: grants(
    'attendance.mark',
    'attendance.approve',
    'stock.consume',
    'site.read',
    'assignment.write',
  ),
  almacen: grants('attendance.mark', 'stock.consume', 'site.read'),
  capataz: grants('attendance.mark', 'attendance.approve', 'stock.consume', 'site.read'),
  trabajador: grants('attendance.mark', 'site.read'),
  // Transversal (§3.2): no grant in the minimal demo matrix.
  vendedor: grants(),
  soporte: grants(),
};

function isRoleCode(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}

/**
 * Pure `role.permits(action)` predicate. Unknown roles and unknown actions are
 * denied, which is what makes the negative matrix rows (auditor writing, caja
 * reading history, trabajador approving third parties) explicit.
 */
export function rolePermitsAction(role: RoleCode | string, action: ActionCode | string): boolean {
  if (!isRoleCode(role)) return false;
  const permits: Set<ActionCode> = ROLE_PERMISSIONS[role];
  return permits.has(action as ActionCode);
}
