// Route registry: one place that declares what each screen is, which skin it
// wears and which actions it requires.
//
// Keeping the route table in a data module (instead of inlining the guard in
// every page) is what makes the UI guard auditable: `decideRouteAccess` is the
// only rule, and it mirrors the action the API endpoint behind the screen
// enforces. `stage` records which ODD task finishes the screen, so a stub is
// never mistaken for a delivered feature.
import {
  type ActionCode,
  type RouteDecision,
  type RouteRequirements,
  decideRouteAccess,
  rolePermitsAction,
} from './access.ts';

/** Visual skin applied to the shell. `neutral` is the base palette. */
export type SkinId = 'neutral' | 'salud' | 'obras';

/** Section the route belongs to; drives the shell's active accent. */
export type SectionId = 'inicio' | 'salud' | 'obras';

/** One navigable screen. */
export interface AppRoute {
  /** Static path, with `[param]` segments for dynamic routes. */
  readonly path: string;
  readonly label: string;
  readonly description: string;
  readonly section: SectionId;
  readonly skin: SkinId;
  /** Actions the screen requires, mirroring the endpoint it calls. */
  readonly requirements: RouteRequirements;
  /** ODD task that delivers the real screen; `W1` means this bootstrap. */
  readonly stage: string;
  /** Route needs a live site id before it can render anything useful. */
  readonly needsSite?: boolean;
  /**
   * Route is reachable by URL but kept out of the navigation and the home
   * list, because it is a detail screen of the entry above it (`/patientes`
   * -> `/pacientes/[id]`). Advertising both would read as two destinations.
   */
  readonly navHidden?: boolean;
}

function requires(
  path: string,
  actions: readonly ActionCode[],
  mode: 'any' | 'all' = 'all',
): RouteRequirements {
  return { path, actions, mode };
}

/**
 * Every screen of the MVP1 web shell. Order is the nav order.
 *
 * `/salud/pacientes` is `any` on purpose: the screen hosts the list
 * (`patient.read`) and the registration form (`patient.write`), and `recepcion`
 * holds only the second — the page gates each capability separately instead of
 * the route denying a legitimate role.
 */
export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: '/',
    label: 'Inicio',
    description: 'Estado de la sesión, del tenant y del API.',
    section: 'inicio',
    skin: 'neutral',
    requirements: requires('/', [], 'all'),
    stage: 'W1',
  },
  {
    // Policy audit (B5). Open route (no actions) on purpose: the preview is a
    // read-only projection of the matrix and the catalog, so any membership
    // of the tenant may read it — the same rationale as the webhook/API-key
    // management screens, which gate on belonging rather than on a vertical.
    // `navHidden` on purpose, like `/onboarding`: an audit destination
    // reachable by URL whose advertising would rewrite the pinned per-role
    // nav lists in `test/access.test.ts` (outside this work unit's surfaces).
    // To advertise it, drop `navHidden` and extend those pins.
    path: '/politicas',
    label: 'Políticas',
    description: 'Matriz rol × acción y probador de políticas por estado.',
    section: 'inicio',
    skin: 'neutral',
    requirements: requires('/politicas', [], 'all'),
    stage: 'B5',
    navHidden: true,
  },
  {
    // First-run setup wizard (H3). Open route (no actions) and `navHidden` on
    // purpose: the run happens before any tenant exists, so it is a setup
    // destination rather than a daily screen — and the pinned per-role nav
    // lists in `test/access.test.ts` stay untouched. Reachable by URL and by
    // `sanitizeNextPath` like any other registry entry.
    path: '/onboarding',
    label: 'Onboarding',
    description: 'Alta inicial: organización, sedes, identidad, facturación, administración y acta.',
    section: 'inicio',
    skin: 'neutral',
    requirements: requires('/onboarding', [], 'all'),
    stage: 'H3',
    navHidden: true,
  },
  {
    path: '/salud/pacientes',
    label: 'Pacientes',
    description: 'Ficha 360: cabecera, consentimientos, episodios y citas.',
    section: 'salud',
    skin: 'salud',
    requirements: requires('/salud/pacientes', ['patient.read', 'patient.write'], 'any'),
    stage: 'W2',
  },
  {
    path: '/salud/pacientes/[id]',
    label: 'Ficha 360',
    description: 'Cabecera del paciente, consentimientos, episodios y citas.',
    section: 'salud',
    skin: 'salud',
    requirements: requires('/salud/pacientes/[id]', ['patient.read'], 'all'),
    stage: 'W2',
    navHidden: true,
  },
  {
    path: '/salud/agenda',
    label: 'Agenda',
    description: 'Citas del día y programación por profesional.',
    section: 'salud',
    skin: 'salud',
    requirements: requires('/salud/agenda', ['agenda.read'], 'all'),
    stage: 'W2',
  },
  {
    path: '/salud/caja',
    label: 'Caja',
    description: 'Turno de caja, cotizaciones, comprobantes y cobros.',
    section: 'salud',
    skin: 'salud',
    requirements: requires('/salud/caja', ['invoice.issue'], 'all'),
    stage: 'W3',
  },
  {
    path: '/salud/imports',
    label: 'Importaciones',
    description: 'Carga de pacientes por CSV, con job y errores descargables.',
    section: 'salud',
    skin: 'salud',
    // The API gates the importer on `patient.write` (`import.service.ts`), not
    // on a read: importing is a write of patient files.
    requirements: requires('/salud/imports', ['patient.write'], 'all'),
    stage: 'W3',
  },
  {
    path: '/salud/tableros/[role]',
    label: 'Tablero por rol',
    description: 'Tableros de recepción, caja y médico con lectura automática.',
    section: 'salud',
    skin: 'salud',
    // `any` on purpose: the caja board is gated on `invoice.issue` and the
    // recepción/médico boards on `agenda.read`, so no single action covers the
    // route. Which board a user may actually open is decided twice: the API
    // requires the caller's role to *be* the board role, and the page mirrors
    // that rule with `boardRoleFor` before issuing a request.
    requirements: requires('/salud/tableros/[role]', ['agenda.read', 'invoice.issue'], 'any'),
    stage: 'W3',
    // Reachable by URL and from the section that owns the role; a nav entry
    // cannot carry the `[role]` segment, so it stays out of the nav list.
    navHidden: true,
  },
  {
    path: '/obras',
    label: 'Obras',
    description: 'Obras del alcance, personal asignado y tablero de empresa.',
    section: 'obras',
    skin: 'obras',
    requirements: requires('/obras', ['site.read'], 'all'),
    stage: 'W4',
  },
  {
    // Declared *before* `/obras/[siteId]` on purpose: `matchRoute` walks the
    // table in order, and a dynamic `[siteId]` segment would otherwise capture
    // `tablero` and resolve the board's URL to the ficha route. Next's file
    // routing already prefers the static segment; this keeps both in agreement.
    //
    // It is a normal nav entry (W6): the route is static, `site.read` reaches it
    // from every construction role, and the company board is the scope-wide view
    // of the vertical rather than a detail screen of one obra — which is exactly
    // what a section entry is for. The pinned nav test that forced `navHidden`
    // in W4 was updated with this change.
    path: '/obras/tablero',
    label: 'Tablero de empresa',
    description: 'Obras y avance agregado del subárbol, con lectura automática.',
    section: 'obras',
    skin: 'obras',
    requirements: requires('/obras/tablero', ['site.read'], 'all'),
    stage: 'W4',
  },
  {
    // Declared *before* `/obras/[siteId]` for the same reason as `/obras/tablero`:
    // `matchRoute` walks the table in order and a dynamic `[siteId]` segment would
    // otherwise capture `imports`.
    //
    // `any` on purpose: the two importers are not gated on the same action
    // (`workers` needs `assignment.write`, `assets` needs `site.write`), and the
    // API decides per endpoint. No construction role below jefatura de obra holds
    // either action, so this entry never reaches a role that could not import:
    // the nav filter keeps it off `trabajador`, `almacen`, `capataz` and
    // `auditor`, and a denial stays a real event for them instead of the normal
    // discovery path.
    path: '/obras/imports',
    label: 'Importaciones',
    description: 'Carga de trabajadores y equipos por CSV, con job y errores descargables.',
    section: 'obras',
    skin: 'obras',
    requirements: requires('/obras/imports', ['site.write', 'assignment.write'], 'any'),
    stage: 'W5',
  },
  {
    path: '/obras/[siteId]',
    label: 'Ficha de obra',
    description: 'Cabecera, personal, asistencia, operación y tablero de la obra.',
    section: 'obras',
    skin: 'obras',
    requirements: requires('/obras/[siteId]', ['site.read'], 'all'),
    stage: 'W4',
    needsSite: true,
    navHidden: true,
  },
];

/** The route table entry for a static path, if any. */
export function routeByPath(path: string): AppRoute | undefined {
  return APP_ROUTES.find((route) => route.path === path);
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Matches a concrete pathname against the table, resolving `[param]` segments.
 * Returns the matched route plus the captured parameters, so a page can read
 * `siteId` from the same source of truth that declared the route.
 */
export function matchRoute(
  pathname: string,
): { readonly route: AppRoute; readonly params: Readonly<Record<string, string>> } | undefined {
  const segments = splitPath(pathname);
  for (const route of APP_ROUTES) {
    const pattern = splitPath(route.path);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const expected = pattern[index] as string;
      const actual = segments[index] as string;
      if (expected.startsWith('[') && expected.endsWith(']')) {
        params[expected.slice(1, -1)] = decodeURIComponent(actual);
        continue;
      }
      if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return undefined;
}

/** Skin of the section that owns `pathname`; `neutral` when unmatched. */
export function skinForPath(pathname: string): SkinId {
  return matchRoute(pathname)?.route.skin ?? 'neutral';
}

/** Every route with at least one permitted action, in nav order. */
export function navItemsFor(
  role: string,
  options: { readonly includeUnreachable?: boolean } = {},
): readonly AppRoute[] {
  const navigable = APP_ROUTES.filter((route) => route.navHidden !== true);
  if (options.includeUnreachable === true) return navigable;
  return navigable.filter((route) => routeAllows(role, route.path).allow);
}

/** Route decision for a role, read straight from the table entry. */
export function routeAllows(role: string, path: string): RouteDecision {
  const route = routeByPath(path);
  if (route === undefined) {
    return { allow: false, reason: 'route.unknown', permitted: [], denied: [] };
  }
  return decideRouteAccess(role, route.requirements);
}

/**
 * Per-capability gate for an already reachable screen. Returns `true` when the
 * role holds `action`; the caller renders the read-only or hidden affordance
 * instead of an error, which is the pattern `/salud/pacientes` needs.
 */
export function can(role: string, action: ActionCode): boolean {
  return rolePermitsAction(role, action);
}

/**
 * Sanitises a post-login redirect target. Only an in-app path from the route
 * table is accepted: an absolute URL, a protocol-relative `//host` or any
 * unknown path collapses to `/`. That is what closes the open-redirect hole of
 * an unvalidated `?next=` parameter.
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '/';
  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\') || value.includes('://')) return '/';

  const [pathname] = value.split(/[?#]/);
  if (pathname === undefined) return '/';
  return matchRoute(pathname) === undefined ? '/' : value;
}
