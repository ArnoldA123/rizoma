// Policy preview — read-only audit projection (B5) over what the code already
// decides: the role × action matrix (`../auth/policy.ts`), the salud board
// gates (`BOARD_ACTIONS` in `salud/dashboards.service.ts`) and the closed
// `state_transitions` catalog (`../state-transitions/`, migration 009, B3).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. There
// is no logic builder here — this module never grants anything the matrix and
// the catalog do not already grant; it only reads both and reports the
// conjunction, for audit. Read-only by construction: the only SQL is a
// `SELECT` over the catalog, and the endpoint layer adds no auth beyond the
// tenant the middleware already bound (any membership of the tenant may
// preview, like any membership may keep a saved view).
import { HttpException } from '@nestjs/common';
import {
  ACTION_CODES,
  rolePermitsAction,
  type ActionCode,
} from '../auth/policy.ts';

/** Entities the 009 catalog covers. Anything else is a 400 (closed). */
export const PREVIEW_ENTITIES = ['episode', 'attendance', 'site_log'] as const;

export type PreviewEntity = (typeof PREVIEW_ENTITIES)[number];

/**
 * Board gate mirror: board → action, the same mapping as `BOARD_ACTIONS` in
 * `salud/dashboards.service.ts`. Duplicated as data (not imported) because
 * that mapping is module-private; the values are pinned by the contract suite
 * (`packages/contracts/src/policy.test.ts`), so a service change without the
 * matching mirror change fails loudly instead of drifting.
 */
export const PREVIEW_BOARD_ACTIONS: Record<string, ActionCode> = {
  recepcion: 'agenda.read',
  caja: 'invoice.issue',
  medico: 'agenda.read',
};

/**
 * Action each catalog entity is enforced with, alongside the catalog row:
 * episodes close on `episode.write` (`salud/salud.service.ts`), attendance
 * approves on `attendance.approve` (`obras/obras.service.ts`), site logs
 * publish on `attendance.mark` (`obras/resources.service.ts`).
 */
export const PREVIEW_TRANSITION_ACTIONS: Record<PreviewEntity, ActionCode> = {
  episode: 'episode.write',
  attendance: 'attendance.approve',
  site_log: 'attendance.mark',
};

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface PreviewClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** One catalog row out of `estado`, as the tenant seeded it. */
export interface PreviewCatalogRow {
  readonly from: string;
  readonly to: string;
  readonly allowedRoles: string[];
}

/** One catalog move with the verdict for the queried role. */
export interface PreviewTransition {
  readonly from: string;
  readonly to: string;
  readonly action: ActionCode;
  readonly roleListed: boolean;
  readonly rolePermits: boolean;
  readonly allowed: boolean;
}

/** One salud board with the action term for the queried role. */
export interface PreviewBoard {
  readonly board: string;
  readonly action: ActionCode;
  readonly allowed: boolean;
}

/** `GET /v1/policy/preview` payload. */
export interface PolicyPreview {
  readonly role: string;
  readonly entity: PreviewEntity;
  readonly estado: string;
  readonly permittedActions: ActionCode[];
  readonly deniedActions: ActionCode[];
  readonly transitions: PreviewTransition[];
  readonly boards: PreviewBoard[];
}

/** Validated `?role=&entity=&estado=` triple. */
export interface PreviewQuery {
  readonly role: string;
  readonly entity: PreviewEntity;
  readonly estado: string;
}

const SELECT_CATALOG_SQL =
  'SELECT from_status, to_status, allowed_roles FROM state_transitions ' +
  'WHERE tenant_id = $1 AND entity = $2 AND from_status = $3 ORDER BY to_status ASC';

function badRequest(code: string, message: string, traceId: string): HttpException {
  return new HttpException({ code, message, traceId }, 400);
}

function isPreviewEntity(value: string): value is PreviewEntity {
  return (PREVIEW_ENTITIES as readonly string[]).includes(value);
}

/**
 * Validates the raw query triple. `role` and `estado` are free strings —
 * deny-by-default is itself a fact worth previewing, so an unknown role
 * answers 200 with everything denied instead of a 400. `entity` is closed
 * (the catalog owns its vocabulary), so anything outside it is a 400
 * `policy.unknown_entity`.
 */
export function parsePreviewQuery(
  raw: { readonly role?: string; readonly entity?: string; readonly estado?: string },
  traceId: string,
): PreviewQuery {
  const role = raw.role ?? '';
  const entity = raw.entity ?? '';
  const estado = raw.estado ?? '';
  if (role.trim() === '' || estado.trim() === '') {
    throw badRequest(
      'policy.invalid_query',
      'Expected non-empty ?role= and ?estado= query parameters',
      traceId,
    );
  }
  if (!isPreviewEntity(entity)) {
    throw badRequest(
      'policy.unknown_entity',
      `Unknown policy entity (expected ${PREVIEW_ENTITIES.join('|')}): ${entity}`,
      traceId,
    );
  }
  return { role, entity, estado };
}

/**
 * Reads the catalog moves out of `estado` for the tenant. Never throws: a
 * missing table reads as "no moves" (fail-closed term, like
 * `assertTransition`), because a preview must not break audit when the
 * catalog is unreachable.
 */
export async function listTransitions(
  client: PreviewClient,
  tenantId: string,
  entity: PreviewEntity,
  estado: string,
): Promise<PreviewCatalogRow[]> {
  try {
    const result = await client.query(SELECT_CATALOG_SQL, [tenantId, entity, estado]);
    return readRows(result).map((row) => ({
      from: typeof row.from_status === 'string' ? row.from_status : '',
      to: typeof row.to_status === 'string' ? row.to_status : '',
      allowedRoles: readStringArray(row.allowed_roles),
    }));
  } catch {
    return [];
  }
}

/** Matrix term: every declared action split into permitted/denied. */
export function splitActions(role: string): {
  readonly permitted: ActionCode[];
  readonly denied: ActionCode[];
} {
  const permitted = (ACTION_CODES as readonly ActionCode[]).filter((action) =>
    rolePermitsAction(role, action),
  );
  const denied = (ACTION_CODES as readonly ActionCode[]).filter(
    (action) => !rolePermitsAction(role, action),
  );
  return { permitted, denied };
}

/**
 * Pure conjunction of the two authorities: one catalog row plus the matrix
 * verdict for the transition action. A move allows only when the role is
 * listed in the row AND the matrix grants the enforcing action.
 */
export function previewTransition(
  role: string,
  entity: PreviewEntity,
  row: PreviewCatalogRow,
): PreviewTransition {
  const action = PREVIEW_TRANSITION_ACTIONS[entity];
  const roleListed = row.allowedRoles.includes(role);
  const permits = rolePermitsAction(role, action);
  return {
    from: row.from,
    to: row.to,
    action,
    roleListed,
    rolePermits: permits,
    allowed: roleListed && permits,
  };
}

/**
 * Builds the full preview: matrix split, catalog moves out of `estado` with
 * the conjunction verdict, and the board action term per salud board.
 */
export async function getPolicyPreview(
  client: PreviewClient,
  tenantId: string,
  role: string,
  entity: PreviewEntity,
  estado: string,
): Promise<PolicyPreview> {
  const { permitted, denied } = splitActions(role);
  const rows = await listTransitions(client, tenantId, entity, estado);
  return {
    role,
    entity,
    estado,
    permittedActions: [...permitted],
    deniedActions: [...denied],
    transitions: rows.map((row) => previewTransition(role, entity, row)),
    boards: Object.entries(PREVIEW_BOARD_ACTIONS).map(([board, action]) => ({
      board,
      action,
      allowed: rolePermitsAction(role, action),
    })),
  };
}
