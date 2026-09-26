// Import-job listing service — reads over `import_jobs` (001, P2-4a).
//
// Plain module with no decorators, like every other service, so the suite
// loads it under Node's strip-only TypeScript and the controller stays a thin
// HTTP skin. This module owns two reads:
//   - `listImportJobs`: the legacy bare array, newest first, capped at
//     `IMPORT_JOB_LIST_LIMIT` (200);
//   - `listImportJobsPage`: the opt-in R1 keyset page `{rows, nextCursor}`.
//
// Guard (the same shape as `getImportJob` in `salud/import.service.ts` and
// `obras/import.service.ts`): the central rule through `canActivate`, auditing
// every denial as `access.denied`, with a successful read writing no audit row
// (reads are not writes). Two adaptations are load-bearing:
//   - `import_jobs` carries no org column, so the listing cannot scope rows to
//     the membership subtree the way the crews/sites listings do; the guard is
//     the membership itself (an active membership in the tenant) plus the
//     role term, and every row of the tenant is visible to a role that may
//     read imports.
//   - the table is vertical-agnostic (salud writes `patient_files_csv`,
//     obras writes `workers_csv`/`assets_csv`), so the role term is the union
//     of the two existing import readers — `patient.write` (salud) or
//     `site.read` (obras) — and the module term is `salud` or `obras`.
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction } from '../auth/policy.ts';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';

/** Rows the import-job listing returns at most; keeps a stray wide scan bounded. */
export const IMPORT_JOB_LIST_LIMIT = 200;

// ============ keyset pagination (R1) ============

/**
 * Default/max page size for the keyset job listing; mirrors
 * `PAGINATION_DEFAULT_LIMIT` / `PAGINATION_MAX_LIMIT` in
 * `packages/contracts/src/pagination.ts`. The API keeps its own constants so
 * the runtime has no cross-package import; the values must stay 200/200 on
 * both sides.
 */
export const IMPORT_JOB_PAGE_DEFAULT_LIMIT = IMPORT_JOB_LIST_LIMIT;
export const IMPORT_JOB_PAGE_MAX_LIMIT = IMPORT_JOB_LIST_LIMIT;

/** `?cursor=` + `?limit=` input for the keyset job listing (filters ride alongside). */
export interface ImportJobPageInput {
  readonly kind?: string | null;
  readonly status?: string | null;
  readonly cursor?: string | null;
  readonly limit?: number | string | null;
}

/** One keyset page: the rows plus the opaque cursor for the next page (null = end). */
export interface ImportJobPage<T> {
  readonly rows: T[];
  readonly nextCursor: string | null;
}

/** Normalizes `?limit=`: absent/empty uses 200, above 200 clamps, anything else outside 1..200 is a 400. */
function parseImportJobPageLimit(raw: number | string | null | undefined, traceId: string): number {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return IMPORT_JOB_PAGE_DEFAULT_LIMIT;
  }
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest('limit must be an integer between 1 and 200', traceId);
  }
  return Math.min(parsed, IMPORT_JOB_PAGE_MAX_LIMIT);
}

/** Encodes one ordering key as the opaque `nextCursor` (base64url JSON, same shape as `encodeCursor` in the contracts). */
function encodeImportJobPageCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes `?cursor=` back to its ordering key; any malformed input is a 400. */
function decodeImportJobPageCursor(cursor: string, traceId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw badRequest('Invalid pagination cursor', traceId);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('Invalid pagination cursor', traceId);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') throw badRequest('Invalid pagination cursor', traceId);
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw badRequest('Invalid pagination cursor', traceId);
  return out;
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

/** `pg` returns INT aggregates as string; normalize to a number. */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** 403 envelope when the caller may not read import jobs. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 400 envelope for a query param that fails validation. */
function badRequest(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'validation.failed', message, traceId }, 400);
}

// ============ actor ============

type HeaderRecord = Record<string, string | string[] | undefined>;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface ImportJobClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Everything a use case needs from the request, framework-free. */
export interface ImportJobActorContext {
  readonly client: ImportJobClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly traceId: string;
  readonly ip: string | null;
}

function readHeader(headers: HeaderRecord | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

/**
 * Builds the actor context from the request the tenant middleware already
 * bound (`req.tenant` + `req.tenantClient`). `roles` stays empty: the guard's
 * role term is computed from `memberships.role`.
 */
export function actorFromImportRequest(req: TenantScopedRequest): ImportJobActorContext {
  const tenant = req.tenant;
  const client = req.tenantClient;
  if (tenant === undefined || client === undefined) {
    throw new HttpException(
      { code: 'tenant.missing', message: 'Request has no tenant context', traceId: randomUUID() },
      403,
    );
  }
  const traceId = readHeader(req.headers as HeaderRecord | undefined, 'x-trace-id') ?? randomUUID();
  const forwarded = readHeader(req.headers as HeaderRecord | undefined, 'x-forwarded-for');
  return {
    client,
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    roles: [],
    traceId,
    ip: forwarded === undefined ? null : (forwarded.split(',')[0]?.trim() ?? null),
  };
}

// ============ record ============

/** One import job as the listing exposes it: identity, kind, outcome and counters. */
export interface ImportJobListItem {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly rowsOk: number;
  readonly rowsError: number;
  readonly createdAt: string | null;
}

function mapImportJobListItem(row: Record<string, unknown>): ImportJobListItem {
  return {
    id: readString(row.id) ?? '',
    kind: readString(row.kind) ?? '',
    status: readString(row.status) ?? '',
    rowsOk: toNumber(row.rows_ok),
    rowsError: toNumber(row.rows_error),
    createdAt: toIso(row.created_at),
  };
}

// ============ guard facts ============

interface ActorFacts {
  readonly membership: MembershipRecord | null;
  readonly moduleActive: boolean;
}

/** Tenant modules whose importers feed `import_jobs` (salud patients, obras workers/equipment). */
const IMPORT_JOB_MODULES = ['salud', 'obras'] as const;

const SELECT_TENANT_MODULES_SQL = 'SELECT modules FROM tenants WHERE id = $1';

async function tenantHasImportModule(client: ImportJobClient, tenantId: string): Promise<boolean> {
  const result = await client.query(SELECT_TENANT_MODULES_SQL, [tenantId]);
  const modules = readRows(result)[0]?.modules;
  return (
    Array.isArray(modules) &&
    (modules as unknown[]).some((module) =>
      (IMPORT_JOB_MODULES as readonly string[]).includes(String(module)),
    )
  );
}

/** Loads membership and import-module activation in the request client. */
async function loadFacts(actor: ImportJobActorContext): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const moduleActive = await tenantHasImportModule(actor.client, actor.tenantId);
  return { membership, moduleActive };
}

interface AuthorizeOptions {
  readonly attemptedAction?: string;
}

/**
 * Runs the central rule and throws 403 on deny. The role term is the union of
 * the two existing import readers — `patient.write` (salud) or `site.read`
 * (obras) — because either vertical's importer may have written the rows.
 */
async function authorize(
  actor: ImportJobActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions = {},
): Promise<MembershipRecord> {
  const role = facts.membership?.role ?? '';
  const rolePermits =
    facts.membership !== null &&
    (rolePermitsAction(role, 'patient.write') || rolePermitsAction(role, 'site.read'));
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: actor.roles, scope: [] },
    membership: facts.membership,
    entityOrgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    scopeSubtree: facts.membership === null ? [] : [facts.membership.orgNodeId],
    rolePermits,
    stateAllows: true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'import_job',
      entityId: null,
      orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
      attemptedAction: options.attemptedAction ?? 'import.read',
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ filters ============

/** `import_jobs.kind` values the importers write (salud patients, obras workers/equipment). */
export const IMPORT_JOB_KINDS = ['patient_files_csv', 'workers_csv', 'assets_csv'] as const;

/** `import_jobs.status` (migration 001 CHECK). */
export const IMPORT_JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;

/** Filters of `GET /v1/imports/jobs`: importer kind and run status. */
export interface ImportJobListFilters {
  readonly kind: string | null;
  readonly status: string | null;
}

/**
 * Parses the job query. Every filter is optional and an empty string counts
 * as absent; an unknown kind or status is a 400, never a silently ignored
 * filter.
 */
export function parseImportJobListFilters(query: unknown, traceId: string): ImportJobListFilters {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const readFilter = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim() === '') return null;
    return value.trim();
  };
  const kind = readFilter(record.kind);
  if (kind !== null && !(IMPORT_JOB_KINDS as readonly string[]).includes(kind)) {
    throw badRequest(`Invalid kind: ${kind}`, traceId);
  }
  const status = readFilter(record.status);
  if (status !== null && !(IMPORT_JOB_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`Invalid status: ${status}`, traceId);
  }
  return { kind, status };
}

// ============ SQL ============

const IMPORT_JOB_LIST_COLUMNS = 'j.id, j.kind, j.status, j.rows_ok, j.rows_error, j.created_at';

function buildImportJobConditions(
  filters: ImportJobListFilters,
  values: unknown[],
): { conditions: string[]; values: unknown[] } {
  const conditions = ['j.tenant_id = $1'];
  if (filters.kind !== null) {
    values.push(filters.kind);
    conditions.push(`j.kind = $${values.length}`);
  }
  if (filters.status !== null) {
    values.push(filters.status);
    conditions.push(`j.status = $${values.length}`);
  }
  return { conditions, values };
}

/**
 * Import jobs of the tenant, newest first, capped at `IMPORT_JOB_LIST_LIMIT`.
 * Same read contract as `getImportJob`: the import guard owns the denial
 * audit and a successful read writes no audit row.
 */
export async function listImportJobs(
  actor: ImportJobActorContext,
  query: unknown = {},
): Promise<ImportJobListItem[]> {
  const filters = parseImportJobListFilters(query, actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, { attemptedAction: 'import_job.list' });
  const values: unknown[] = [actor.tenantId];
  const { conditions } = buildImportJobConditions(filters, values);
  const result = await actor.client.query(
    `SELECT ${IMPORT_JOB_LIST_COLUMNS} FROM import_jobs j ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY j.created_at DESC, j.id DESC LIMIT ${IMPORT_JOB_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapImportJobListItem);
}

/**
 * Keyset page of the import jobs of the tenant.
 *
 * Stable order: `created_at DESC, id DESC` — the legacy newest-first order
 * plus the `id` tiebreaker, so equal timestamps paginate deterministically.
 * The cursor is the opaque base64url of the last row's `{createdAt, id}`; the
 * query fetches `limit + 1` rows and a non-null `nextCursor` means there is
 * another page. Every filter ANDs with the keyset predicate, so a filtered
 * walk stays inside the filter.
 */
export async function listImportJobsPage(
  actor: ImportJobActorContext,
  options: ImportJobPageInput = {},
): Promise<ImportJobPage<ImportJobListItem>> {
  const filters = parseImportJobListFilters(options, actor.traceId);
  const limit = parseImportJobPageLimit(options.limit, actor.traceId);
  const facts = await loadFacts(actor);
  await authorize(actor, facts, { attemptedAction: 'import_job.list' });
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  const rawCursor = typeof options.cursor === 'string' ? options.cursor.trim() : '';
  if (rawCursor !== '') {
    const payload = decodeImportJobPageCursor(rawCursor, actor.traceId);
    cursorCreatedAt = payload.createdAt ?? null;
    cursorId = payload.id ?? null;
    if (cursorCreatedAt === null || cursorId === null) {
      throw badRequest('Invalid pagination cursor', actor.traceId);
    }
    if (Number.isNaN(Date.parse(cursorCreatedAt))) {
      throw badRequest('Invalid pagination cursor', actor.traceId);
    }
    if (!UUID_RE.test(cursorId)) throw badRequest('Invalid pagination cursor', actor.traceId);
  }
  const values: unknown[] = [actor.tenantId];
  const { conditions } = buildImportJobConditions(filters, values);
  if (cursorCreatedAt !== null && cursorId !== null) {
    values.push(cursorCreatedAt, cursorId);
    const createdAtParam = values.length - 1;
    const idParam = values.length;
    conditions.push(
      `(j.created_at < $${createdAtParam}::timestamptz OR ` +
        `(j.created_at = $${createdAtParam}::timestamptz AND j.id < $${idParam}::uuid))`,
    );
  }
  const result = await actor.client.query(
    `SELECT ${IMPORT_JOB_LIST_COLUMNS} FROM import_jobs j ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY j.created_at DESC, j.id DESC LIMIT ${limit + 1}`,
    values,
  );
  const rows = readRows(result).map(mapImportJobListItem);
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (last === undefined || last.createdAt === null) return { rows: page, nextCursor: null };
  return {
    rows: page,
    nextCursor: encodeImportJobPageCursor({ createdAt: last.createdAt, id: last.id }),
  };
}
