// Obras CSV importers + boards coverage (bases-consolidadas-v1.md §2.4, §3.4,
// §6.2).
//
// The SQL client is a small stateful in-memory double that implements the exact
// statements `import.service.ts` and `dashboards.service.ts` issue over a set of
// synthetic tables, so the suite exercises the real control flow (guard,
// per-row validation, duplicate handling, hash idempotency, savepoint protocol,
// board queries) without Postgres. All data is synthetic (`@example.invalid`
// identities).
//
// Board coverage lives here because `import.test.ts` is the only O4 test file
// inside the allowed edit surface that the `npm test` script loads; the HTTP
// skin of both services stays covered by `obras.e2e.test.ts` (opt-in stack).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  IMPORT_ERROR,
  IMPORT_KIND_ASSETS_CSV,
  IMPORT_KIND_WORKERS_CSV,
  IMPORT_ROW_ERROR,
  buildErrorsCsv,
  getImportJob,
  importAssets,
  importWorkers,
  parseAssetsCsv,
  parseWorkersCsv,
} from './import.service.ts';
import { getCompanyBoard, getSiteBoard, type CompanyBoard, type SiteBoard } from './dashboards.service.ts';
import type { ObraActorContext, ObraClient } from './obras.service.ts';

// ============ synthetic fixtures ============

const TENANT = 'a4000000-0000-4000-8000-0000000000a1';
const EMPRESA = 'b4000000-0000-4000-8000-000000000001';
const SEDE = 'b4000000-0000-4000-8000-000000000002';
const NODE_A = 'b4000000-0000-4000-8000-000000000003';
const NODE_B = 'b4000000-0000-4000-8000-000000000004';
const OUTSIDE = 'b4000000-0000-4000-8000-000000000099';
const SITE_A = 'c4000000-0000-4000-8000-000000000001';
const SITE_B = 'c4000000-0000-4000-8000-000000000002';
const U_GERENTE = 'd4000000-0000-4000-8000-000000000001';
const U_JEFE = 'd4000000-0000-4000-8000-000000000002';
const U_WORKER = 'd4000000-0000-4000-8000-000000000003';
const M_GERENTE = 'e4000000-0000-4000-8000-000000000001';
const M_JEFE = 'e4000000-0000-4000-8000-000000000002';
const M_WORKER = 'e4000000-0000-4000-8000-000000000003';
const ITEM_CEMENTO = 'f4000000-0000-4000-8000-000000000011';
const ITEM_ARENA = 'f4000000-0000-4000-8000-000000000012';
const ASSET_MAINT = 'f4000000-0000-4000-8000-000000000021';
const ASSET_AVAILABLE = 'f4000000-0000-4000-8000-000000000022';
const BL_MUROS = 'f4000000-0000-4000-8000-000000000031';
const MILESTONE_DUE = 'f4000000-0000-4000-8000-000000000041';
const MILESTONE_DONE = 'f4000000-0000-4000-8000-000000000042';
const MILESTONE_FAR = 'f4000000-0000-4000-8000-000000000043';
const TRACE = 'trace-obras-import';
const NOW = '2026-03-02T12:00:00.000Z';
const DAY = '2026-03-02';
const MODULES = ['crm-core', 'obras'];
const IDEMPOTENCY_KEY = 'idem-obras-1';

const WORKERS_HEADER = 'name,email,phone,role,org_node_id';
const ASSETS_HEADER = 'code,kind,serial,horometer,org_node_id';

function validWorkersCsv(): string {
  return [
    WORKERS_HEADER,
    'Trabajador Demo Uno,uno@example.invalid,999888777,trabajador,',
    `Capataz Demo Dos,dos@example.invalid,,capataz,${NODE_B}`,
  ].join('\n');
}

function validAssetsCsv(): string {
  return [
    ASSETS_HEADER,
    'EQ-101,mezcladora,SN-101,120.5,',
    `EQ-102,compactadora,SN-102,,${NODE_B}`,
  ].join('\n');
}

// ============ in-memory query double ============

type Row = Record<string, unknown>;

interface MembershipSpec {
  readonly id: string;
  readonly userId: string;
  readonly orgNodeId: string;
  readonly role: string;
  readonly active: boolean;
  readonly userActive: boolean;
  readonly validFrom: string;
  readonly validTo: string | null;
}

interface IdempotencyEntry {
  requestHash: string;
  response: unknown;
  valid: boolean;
}

interface FakeState {
  callerUserId: string;
  memberships: Map<string, MembershipSpec>;
  subtree: string[];
  modules: string[];
  sites: Map<string, Row>;
  assignments: Map<string, Row>;
  users: Map<string, Row>;
  importedMemberships: Row[];
  assets: Map<string, Row>;
  readings: Map<string, Row>;
  items: Map<string, Row>;
  moves: Map<string, Row>;
  budgetLines: Map<string, Row>;
  progress: Map<string, Row>;
  attendance: Map<string, Row>;
  milestones: Map<string, Row>;
  attachments: Map<string, Row>;
  jobs: Map<string, Row>;
  idempotency: Map<string, IdempotencyEntry>;
  audits: Row[];
  sequence: number;
}

interface FakeDb {
  readonly client: ObraClient;
  readonly state: FakeState;
  readonly queries: { text: string; values: readonly unknown[] }[];
}

function nextId(state: FakeState): string {
  state.sequence += 1;
  return `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
}

function uniqueViolation(): Error {
  const error = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  error.code = '23505';
  return error;
}

function spec(
  id: string,
  userId: string,
  orgNodeId: string,
  role: string,
  overrides: Partial<MembershipSpec> = {},
): MembershipSpec {
  return {
    id,
    userId,
    orgNodeId,
    role,
    active: true,
    userActive: true,
    validFrom: '2025-01-01T00:00:00.000Z',
    validTo: null,
    ...overrides,
  };
}

function defaultMemberships(): Map<string, MembershipSpec> {
  return new Map<string, MembershipSpec>([
    [U_GERENTE, spec(M_GERENTE, U_GERENTE, EMPRESA, 'gerente')],
    [U_JEFE, spec(M_JEFE, U_JEFE, SEDE, 'jefe_obra')],
    [U_WORKER, spec(M_WORKER, U_WORKER, NODE_A, 'trabajador')],
  ]);
}

function siteRow(id: string, orgNodeId: string, code: string, status = 'active'): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: orgNodeId,
    code,
    name: `Obra ${code}`,
    client_name: 'Cliente Ficticio',
    budget_total: 100000,
    started_at: '2025-01-15T00:00:00.000Z',
    ended_at: null,
    status,
  };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    callerUserId: U_GERENTE,
    memberships: defaultMemberships(),
    subtree: [EMPRESA, SEDE, NODE_A, NODE_B],
    modules: MODULES,
    sites: new Map<string, Row>([
      [SITE_A, siteRow(SITE_A, NODE_A, 'OBR-A')],
      [SITE_B, siteRow(SITE_B, NODE_B, 'OBR-B')],
    ]),
    assignments: new Map<string, Row>(),
    users: new Map<string, Row>(),
    importedMemberships: [],
    assets: new Map<string, Row>([
      [
        ASSET_MAINT,
        {
          id: ASSET_MAINT,
          tenant_id: TENANT,
          org_node_id: NODE_A,
          code: 'EQ-M-1',
          kind: 'grua',
          serial: 'SN-M-1',
          status: 'maintenance',
          current_site_id: null,
        },
      ],
      [
        ASSET_AVAILABLE,
        {
          id: ASSET_AVAILABLE,
          tenant_id: TENANT,
          org_node_id: NODE_A,
          code: 'EQ-A-1',
          kind: 'mezcladora',
          serial: 'SN-A-1',
          status: 'available',
          current_site_id: null,
        },
      ],
    ]),
    readings: new Map<string, Row>(),
    items: new Map<string, Row>([
      [ITEM_CEMENTO, { id: ITEM_CEMENTO, tenant_id: TENANT, sku: 'CEM-001', name: 'Cemento', unit: 'bolsa', min_stock: 5, active: true }],
      [ITEM_ARENA, { id: ITEM_ARENA, tenant_id: TENANT, sku: 'ARE-001', name: 'Arena', unit: 'm3', min_stock: 10, active: true }],
    ]),
    moves: new Map<string, Row>([
      ['f4000000-0000-4000-8000-000000000051', { id: 'f4000000-0000-4000-8000-000000000051', tenant_id: TENANT, item_id: ITEM_CEMENTO, warehouse_node_id: NODE_A, site_id: null, qty: 3, kind: 'in', at: NOW, status: 'posted' }],
      ['f4000000-0000-4000-8000-000000000052', { id: 'f4000000-0000-4000-8000-000000000052', tenant_id: TENANT, item_id: ITEM_ARENA, warehouse_node_id: NODE_A, site_id: null, qty: 50, kind: 'in', at: NOW, status: 'posted' }],
    ]),
    budgetLines: new Map<string, Row>([
      [BL_MUROS, { id: BL_MUROS, tenant_id: TENANT, site_id: SITE_A, item_id: null, description: 'Muros', qty_planned: 100, unit_cost: 25, active: true }],
    ]),
    progress: new Map<string, Row>([
      ['f4000000-0000-4000-8000-000000000061', { id: 'f4000000-0000-4000-8000-000000000061', tenant_id: TENANT, site_id: SITE_A, budget_line_id: BL_MUROS, qty_done: 40, at: NOW, reported_by: U_JEFE, status: 'posted' }],
      ['f4000000-0000-4000-8000-000000000062', { id: 'f4000000-0000-4000-8000-000000000062', tenant_id: TENANT, site_id: SITE_A, budget_line_id: BL_MUROS, qty_done: 10, at: NOW, reported_by: U_JEFE, status: 'draft' }],
    ]),
    attendance: new Map<string, Row>([
      ['f4000000-0000-4000-8000-000000000071', { id: 'f4000000-0000-4000-8000-000000000071', tenant_id: TENANT, user_id: U_WORKER, site_id: SITE_A, check_in: `${DAY}T08:00:00.000Z`, check_out: null, source: 'web', status: 'registered', approved_by: null }],
      ['f4000000-0000-4000-8000-000000000072', { id: 'f4000000-0000-4000-8000-000000000072', tenant_id: TENANT, user_id: U_JEFE, site_id: SITE_A, check_in: `${DAY}T08:05:00.000Z`, check_out: null, source: 'web', status: 'approved', approved_by: U_GERENTE }],
      ['f4000000-0000-4000-8000-000000000073', { id: 'f4000000-0000-4000-8000-000000000073', tenant_id: TENANT, user_id: U_GERENTE, site_id: SITE_A, check_in: `${DAY}T08:10:00.000Z`, check_out: null, source: 'web', status: 'registered', approved_by: null }],
    ]),
    milestones: new Map<string, Row>([
      [MILESTONE_DUE, { id: MILESTONE_DUE, tenant_id: TENANT, site_id: SITE_A, name: 'Cimentación', due_at: '2026-03-10T00:00:00.000Z', status: 'pending' }],
      [MILESTONE_DONE, { id: MILESTONE_DONE, tenant_id: TENANT, site_id: SITE_A, name: 'Trazo', due_at: '2026-02-20T00:00:00.000Z', status: 'done' }],
      [MILESTONE_FAR, { id: MILESTONE_FAR, tenant_id: TENANT, site_id: SITE_A, name: 'Acabados', due_at: '2026-12-01T00:00:00.000Z', status: 'pending' }],
    ]),
    attachments: new Map<string, Row>(),
    jobs: new Map<string, Row>(),
    idempotency: new Map<string, IdempotencyEntry>(),
    audits: [],
    sequence: 0,
    ...overrides,
  };
}

function membershipRow(record: MembershipSpec): Row {
  return {
    id: record.id,
    user_id: record.userId,
    tenant_id: TENANT,
    org_node_id: record.orgNodeId,
    role: record.role,
    scopes: [],
    active: record.active,
    valid_from: record.validFrom,
    valid_to: record.validTo,
    user_active: record.userActive,
  };
}

function inWindow(row: Row): boolean {
  if (row.active !== true) return false;
  if (String(row.valid_from) > NOW) return false;
  if (row.valid_to !== null && String(row.valid_to) < NOW) return false;
  return true;
}

/** Sites whose org node is inside the given scope, as UUID strings. */
function siteIdsInScope(state: FakeState, scope: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const row of state.sites.values()) {
    if (scope.includes(String(row.org_node_id))) ids.add(String(row.id));
  }
  return ids;
}

/**
 * Stateful double: one branch per statement fragment the services issue. Branch
 * order matters where fragments share a prefix, so writes and the aggregate
 * reads are checked before the plain table reads.
 */
function createDb(state: FakeState): FakeDb {
  const queries: { text: string; values: readonly unknown[] }[] = [];

  const client: ObraClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push({ text, values });
      const v = values;

      // ---- per-row transaction isolation ----
      if (
        text.startsWith('SAVEPOINT') ||
        text.startsWith('RELEASE SAVEPOINT') ||
        text.startsWith('ROLLBACK TO SAVEPOINT')
      ) {
        return { rows: [] };
      }

      // ---- audit (write and denial share the table) ----
      if (text.includes('INSERT INTO audit_log')) {
        if (v.length === 7) {
          state.audits.push({
            action: 'access.denied',
            entity: v[2],
            entity_id: v[3],
            org_node_id: v[4],
            diff: JSON.parse(String(v[5])) as Row,
          });
          return { rows: [] };
        }
        state.audits.push({
          action: v[2],
          entity: v[3],
          entity_id: v[4],
          org_node_id: v[5],
          diff: JSON.parse(String(v[6])) as Row,
        });
        return { rows: [] };
      }

      // ---- guard facts ----
      if (text.includes('FROM memberships')) {
        const record = state.memberships.get(String(v[0]));
        return { rows: record === undefined ? [] : [membershipRow(record)] };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: state.subtree.map((id) => ({ id })) };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: state.modules }] };
      }

      // ---- idempotency store ----
      if (text.includes('INSERT INTO idempotency_keys')) {
        const key = String(v[1]);
        if (state.idempotency.has(key)) return { rows: [] };
        state.idempotency.set(key, { requestHash: String(v[2]), response: null, valid: true });
        return { rows: [{ key }] };
      }
      if (text.includes('FROM idempotency_keys') && text.includes('FOR UPDATE')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry === undefined) return { rows: [] };
        return {
          rows: [{ request_hash: entry.requestHash, response: entry.response, still_valid: entry.valid }],
        };
      }
      if (text.includes('UPDATE idempotency_keys') && text.includes('SET request_hash')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry !== undefined) {
          entry.requestHash = String(v[2]);
          entry.response = null;
          entry.valid = true;
        }
        return { rows: [] };
      }
      if (text.includes('UPDATE idempotency_keys') && text.includes('SET response')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry !== undefined) entry.response = JSON.parse(String(v[2])) as unknown;
        return { rows: [] };
      }
      if (text.includes('DELETE FROM idempotency_keys')) {
        state.idempotency.delete(String(v[1]));
        return { rows: [] };
      }
      if (text.includes('FROM idempotency_keys')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry === undefined) return { rows: [] };
        return { rows: [{ response: entry.response }] };
      }

      // ---- importer writes ----
      if (text.includes('INSERT INTO users')) {
        for (const row of state.users.values()) {
          if (row.email === v[2]) throw uniqueViolation();
        }
        const row: Row = {
          id: nextId(state),
          tenant_id: v[0],
          name: v[1],
          email: v[2],
          phone: v[3],
          active: false,
        };
        state.users.set(String(row.id), row);
        return { rows: [{ id: row.id }] };
      }
      if (text.includes('INSERT INTO memberships')) {
        const row: Row = {
          id: nextId(state),
          user_id: v[0],
          tenant_id: v[1],
          org_node_id: v[2],
          role: v[3],
          scopes: [],
          active: true,
        };
        state.importedMemberships.push(row);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO assets')) {
        for (const row of state.assets.values()) {
          if (row.code === v[2]) throw uniqueViolation();
        }
        const row: Row = {
          id: nextId(state),
          tenant_id: v[0],
          org_node_id: v[1],
          code: v[2],
          kind: v[3],
          serial: v[4],
          status: 'available',
          current_site_id: null,
        };
        state.assets.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO asset_readings')) {
        const row: Row = {
          id: nextId(state),
          tenant_id: v[0],
          asset_id: v[1],
          kind: v[2],
          value: v[3],
          at: NOW,
          source: 'import',
        };
        state.readings.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO attachments')) {
        const id = nextId(state);
        state.attachments.set(id, {
          id,
          tenant_id: v[0],
          bucket_key: v[1],
          sha256: v[2],
          mime: 'text/csv',
          size_bytes: v[3],
          uploaded_by: v[4],
        });
        return { rows: [{ id }] };
      }
      if (text.includes('INSERT INTO import_jobs')) {
        const id = nextId(state);
        const row: Row = {
          id,
          tenant_id: v[0],
          kind: v[1],
          file_id: v[2],
          status: v[3],
          rows_ok: v[4],
          rows_error: v[5],
          errors_file_id: v[6],
          created_at: NOW,
        };
        state.jobs.set(id, row);
        return { rows: [row] };
      }
      if (text.includes('FROM import_jobs')) {
        const job = state.jobs.get(String(v[1]));
        if (job === undefined) return { rows: [] };
        const file = state.attachments.get(String(job.file_id));
        return { rows: [{ ...job, file_sha256: file?.sha256 ?? null }] };
      }

      // ---- boards: sites ----
      if (text.includes('FROM sites') && text.includes('COUNT(*) AS total')) {
        const scope = v[1] as readonly unknown[];
        const rows = [...state.sites.values()].filter((row) => scope.includes(String(row.org_node_id)));
        const count = (status: string): number => rows.filter((row) => row.status === status).length;
        return {
          rows: [{ total: rows.length, active: count('active'), planned: count('planned'), closed: count('closed') }],
        };
      }
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        const row = state.sites.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }

      // ---- boards: assignments (requireSiteAccess key) ----
      if (text.includes('FROM assignments') && text.includes('user_id = $2 AND site_id = $3')) {
        for (const row of state.assignments.values()) {
          if (String(row.user_id) !== String(v[1]) || String(row.site_id) !== String(v[2])) continue;
          if (String(row.tenant_id) !== String(v[0]) || !inWindow(row)) continue;
          return { rows: [row] };
        }
        return { rows: [] };
      }

      // ---- boards: progress by budget line ----
      if (text.includes('LEFT JOIN progress_entries')) {
        const siteId = String(v[1]);
        const rows: Row[] = [];
        for (const line of state.budgetLines.values()) {
          if (String(line.site_id) !== siteId || line.active !== true) continue;
          let done = 0;
          for (const entry of state.progress.values()) {
            if (String(entry.budget_line_id) !== String(line.id) || entry.status !== 'posted') continue;
            done += Number(entry.qty_done);
          }
          rows.push({
            budget_line_id: line.id,
            description: line.description,
            qty_planned: line.qty_planned,
            qty_done: done,
          });
        }
        return { rows };
      }

      // ---- boards: company global progress ----
      if (text.includes('FROM budget_lines b') && text.includes('SUM(b.qty_planned)')) {
        const siteIds = siteIdsInScope(state, v[1] as readonly unknown[]);
        let total = 0;
        for (const line of state.budgetLines.values()) {
          if (line.active === true && siteIds.has(String(line.site_id))) total += Number(line.qty_planned);
        }
        return { rows: [{ qty_planned: total }] };
      }
      if (text.includes('FROM progress_entries p') && text.includes('SUM(p.qty_done)')) {
        const siteIds = siteIdsInScope(state, v[1] as readonly unknown[]);
        let total = 0;
        for (const entry of state.progress.values()) {
          if (entry.status === 'posted' && siteIds.has(String(entry.site_id))) total += Number(entry.qty_done);
        }
        return { rows: [{ qty_done: total }] };
      }

      // ---- boards: attendance of the day, by status ----
      if (text.includes('FROM attendance') && text.includes('GROUP BY status')) {
        const siteId = String(v[1]);
        const date = String(v[2]);
        const counts = new Map<string, number>();
        for (const row of state.attendance.values()) {
          if (String(row.site_id) !== siteId || !String(row.check_in).startsWith(date)) continue;
          const status = String(row.status);
          counts.set(status, (counts.get(status) ?? 0) + 1);
        }
        return { rows: [...counts.entries()].map(([status, total]) => ({ status, total })) };
      }

      // ---- boards: critical stock ----
      if (text.includes('FROM inventory_items i') && text.includes('HAVING')) {
        const scope = v[1] as readonly unknown[];
        const rows: Row[] = [];
        for (const item of state.items.values()) {
          if (item.active !== true) continue;
          let available = 0;
          for (const move of state.moves.values()) {
            if (String(move.item_id) !== String(item.id) || move.status !== 'posted') continue;
            if (!scope.includes(String(move.warehouse_node_id))) continue;
            available += move.kind === 'in' ? Number(move.qty) : -Number(move.qty);
          }
          if (available < Number(item.min_stock)) {
            rows.push({
              item_id: item.id,
              sku: item.sku,
              name: item.name,
              unit: item.unit,
              min_stock: item.min_stock,
              available,
            });
          }
        }
        return { rows };
      }

      // ---- boards: equipment in maintenance ----
      if (text.includes('FROM assets') && text.includes("status = 'maintenance'")) {
        const scope = v[1] as readonly unknown[];
        const rows: Row[] = [];
        for (const asset of state.assets.values()) {
          if (asset.status !== 'maintenance' || !scope.includes(String(asset.org_node_id))) continue;
          rows.push({ id: asset.id, code: asset.code, kind: asset.kind, serial: asset.serial });
        }
        return { rows };
      }

      // ---- boards: upcoming milestones ----
      if (text.includes('FROM milestones') && text.includes("status <> 'done'")) {
        const siteId = String(v[1]);
        const horizon = new Date(Date.parse(NOW) + 30 * 86400000).toISOString();
        const rows: Row[] = [];
        for (const milestone of state.milestones.values()) {
          if (String(milestone.site_id) !== siteId || milestone.status === 'done') continue;
          if (String(milestone.due_at) >= horizon) continue;
          rows.push({ id: milestone.id, name: milestone.name, due_at: milestone.due_at, status: milestone.status });
        }
        return { rows };
      }

      return { rows: [] };
    },
  };
  return { client, state, queries };
}

function makeDb(overrides: Partial<FakeState> = {}): FakeDb {
  return createDb(baseState(overrides));
}

function actor(db: FakeDb, overrides: Partial<ObraActorContext> = {}): ObraActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: db.state.callerUserId,
    roles: [],
    traceId: TRACE,
    ip: '127.0.0.1',
    ...overrides,
  };
}

/** Extracts `{status, body}` from a thrown Nest `HttpException`. */
function httpError(error: unknown): { status: number; body: Row } | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse() as unknown;
  const body = typeof response === 'object' && response !== null ? (response as Row) : {};
  return { status: error.getStatus(), body };
}

function isError(code: string, status = 400): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    const http = httpError(error);
    return http !== null && http.status === status && http.body.code === code;
  };
}

function importBody(csv: string, orgNodeId = EMPRESA): Row {
  return { csv, orgNodeId };
}

function savepointQueries(db: FakeDb): { savepoints: number; releases: number; rollbacks: number } {
  return {
    savepoints: db.queries.filter((query) => query.text === 'SAVEPOINT import_row').length,
    releases: db.queries.filter((query) => query.text === 'RELEASE SAVEPOINT import_row').length,
    rollbacks: db.queries.filter((query) => query.text === 'ROLLBACK TO SAVEPOINT import_row').length,
  };
}

// ============ parseWorkersCsv ============

describe('parseWorkersCsv', () => {
  it('parses a valid file into rows, keeping the optional columns', () => {
    const parsed = parseWorkersCsv(validWorkersCsv());
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows.length, 2);
    assert.deepEqual(parsed.rows[0], {
      rowNumber: 2,
      name: 'Trabajador Demo Uno',
      email: 'uno@example.invalid',
      phone: '999888777',
      role: 'trabajador',
      orgNodeId: null,
    });
    assert.equal(parsed.rows[1]?.orgNodeId, NODE_B);
    assert.equal(parsed.rows[1]?.phone, null);
  });

  it('accepts quoted fields with commas and escaped quotes', () => {
    const csv = [WORKERS_HEADER, '"Pérez, Juan ""El Capataz""",juan@example.invalid,,capataz,'].join('\n');
    const parsed = parseWorkersCsv(csv);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows[0]?.name, 'Pérez, Juan "El Capataz"');
  });

  it('accepts CRLF line endings and ignores blank trailing lines', () => {
    const parsed = parseWorkersCsv(`${validWorkersCsv()}\r\n\r\n`);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.errors.length, 0);
  });

  it('reports a missing required column as a structural 400', () => {
    assert.throws(
      () => parseWorkersCsv('name,email\nTrabajador Demo,demo@example.invalid\n'),
      isError(IMPORT_ERROR.invalidCsv),
    );
  });

  it('reports an empty file as a structural 400', () => {
    assert.throws(() => parseWorkersCsv('   '), isError(IMPORT_ERROR.invalidCsv));
  });

  it('collects name, email and role errors and keeps the valid rows', () => {
    const csv = [
      WORKERS_HEADER,
      ',sin-nombre@example.invalid,,trabajador,',
      'Trabajador Email Malo,no-es-email,,trabajador,',
      'Trabajador Rol Malo,rol@example.invalid,,medico,',
      'Trabajador Sede Mala,sede@example.invalid,,trabajador,not-a-uuid',
      'Trabajador Bueno,bueno@example.invalid,999000111,capataz,',
    ].join('\n');
    const parsed = parseWorkersCsv(csv);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]?.email, 'bueno@example.invalid');
    assert.deepEqual(
      parsed.errors.map((error) => [error.rowNumber, error.field, error.code]),
      [
        [2, 'name', IMPORT_ROW_ERROR.fieldRequired],
        [3, 'email', IMPORT_ROW_ERROR.invalidEmail],
        [4, 'role', IMPORT_ROW_ERROR.invalidRole],
        [5, 'org_node_id', IMPORT_ROW_ERROR.invalidOrgNode],
      ],
    );
  });
});

// ============ importWorkers ============

describe('importWorkers', () => {
  it('creates an inactive user plus its membership and counts the rows', async () => {
    const db = makeDb();
    const job = await importWorkers(actor(db), importBody(validWorkersCsv()), IDEMPOTENCY_KEY);

    assert.equal(job.kind, IMPORT_KIND_WORKERS_CSV);
    assert.equal(job.status, 'completed');
    assert.equal(job.rowsOk, 2);
    assert.equal(job.rowsError, 0);
    assert.equal(job.fileSha256?.length, 64);
    assert.equal(db.state.users.size, 2);
    assert.equal(db.state.importedMemberships.length, 2);
    for (const user of db.state.users.values()) assert.equal(user.active, false);
    const [first, second] = db.state.importedMemberships;
    assert.equal(first?.role, 'trabajador');
    assert.equal(first?.org_node_id, EMPRESA);
    assert.equal(second?.role, 'capataz');
    assert.equal(second?.org_node_id, NODE_B);
  });

  it('is idempotent by file hash: a replayed file returns the original job', async () => {
    const db = makeDb();
    const first = await importWorkers(actor(db), importBody(validWorkersCsv()), IDEMPOTENCY_KEY);
    const second = await importWorkers(actor(db), importBody(validWorkersCsv()), 'another-key');
    assert.equal(second.id, first.id);
    assert.equal(second.rowsOk, first.rowsOk);
    assert.equal(db.state.jobs.size, 1);
    assert.equal(db.state.users.size, 2);
  });

  it('rejects the same file for a different org node with import.idempotency_conflict', async () => {
    const db = makeDb();
    await importWorkers(actor(db), importBody(validWorkersCsv()), IDEMPOTENCY_KEY);
    await assert.rejects(
      importWorkers(actor(db), importBody(validWorkersCsv(), SEDE), IDEMPOTENCY_KEY),
      isError(IMPORT_ERROR.idempotencyConflict, 409),
    );
  });

  it('counts an email repeated inside the file as a row error', async () => {
    const csv = [
      WORKERS_HEADER,
      'Trabajador Uno,repetido@example.invalid,,trabajador,',
      'Trabajador Dos,repetido@example.invalid,,capataz,',
    ].join('\n');
    const db = makeDb();
    const job = await importWorkers(actor(db), importBody(csv), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 1);
    assert.match(job.errorsCsv ?? '', /import\.worker_duplicate/);
    assert.equal(db.state.users.size, 1);
  });

  it('counts an email already in the tenant as a row error instead of aborting', async () => {
    const state = baseState();
    state.users.set('existing', { id: 'existing', tenant_id: TENANT, name: 'X', email: 'uno@example.invalid', phone: null, active: true });
    const db = createDb(state);
    const job = await importWorkers(actor(db), importBody(validWorkersCsv()), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 1);
    assert.match(job.errorsCsv ?? '', /import\.worker_duplicate/);
  });

  it('rejects a row org node outside the caller subtree without writing it', async () => {
    const csv = [WORKERS_HEADER, `Ajeno,ajeno@example.invalid,,trabajador,${OUTSIDE}`].join('\n');
    const db = makeDb();
    const job = await importWorkers(actor(db), importBody(csv), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 0);
    assert.equal(job.rowsError, 1);
    assert.match(job.errorsCsv ?? '', /import\.org_node_out_of_scope/);
    assert.equal(db.state.users.size, 0);
  });

  it('isolates every row insert in a savepoint so a duplicate cannot abort the run', async () => {
    const state = baseState();
    state.users.set('existing', { id: 'existing', tenant_id: TENANT, name: 'X', email: 'uno@example.invalid', phone: null, active: true });
    const db = createDb(state);
    const job = await importWorkers(actor(db), importBody(validWorkersCsv()), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 1);
    assert.deepEqual(savepointQueries(db), { savepoints: 2, releases: 1, rollbacks: 1 });
  });

  it('requires the Idempotency-Key header', async () => {
    const db = makeDb();
    await assert.rejects(
      importWorkers(actor(db), importBody(validWorkersCsv()), undefined),
      isError(IMPORT_ERROR.idempotencyKeyRequired),
    );
  });

  it('rejects a body without csv or with a non-UUID orgNodeId', async () => {
    const db = makeDb();
    await assert.rejects(
      importWorkers(actor(db), { csv: '   ', orgNodeId: EMPRESA }, IDEMPOTENCY_KEY),
      isError(IMPORT_ERROR.csvRequired),
    );
    await assert.rejects(
      importWorkers(actor(db), { csv: validWorkersCsv(), orgNodeId: 'nope' }, IDEMPOTENCY_KEY),
      isError(IMPORT_ERROR.invalidOrgNode),
    );
  });

  it('denies a role without assignment.write and audits the denial', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await assert.rejects(
      importWorkers(actor(db), importBody(validWorkersCsv(), NODE_A), IDEMPOTENCY_KEY),
      isError('access.denied', 403),
    );
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal(denied.length, 1);
    assert.equal((denied[0]?.diff as Row).attemptedAction, 'import.workers_csv');
  });

  it('writes one import.completed audit row with the run counts', async () => {
    const db = makeDb();
    const job = await importWorkers(actor(db), importBody(validWorkersCsv()), IDEMPOTENCY_KEY);
    const completed = db.state.audits.filter((row) => row.action === 'import.completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.entity, 'import_job');
    assert.equal(completed[0]?.entity_id, job.id);
    const diff = completed[0]?.diff as Row;
    assert.equal(diff.kind, IMPORT_KIND_WORKERS_CSV);
    assert.equal(diff.rowsOk, 2);
    assert.equal(diff.rowsError, 0);
  });

  it('recovers the errors CSV of a job through getImportJob', async () => {
    const csv = [WORKERS_HEADER, ',malo@example.invalid,,trabajador,'].join('\n');
    const db = makeDb();
    const job = await importWorkers(actor(db), importBody(csv), IDEMPOTENCY_KEY);
    const fetched = await getImportJob(actor(db), job.id);
    assert.equal(fetched.id, job.id);
    assert.equal(fetched.rowsError, 1);
    assert.equal(fetched.errorsCsv, job.errorsCsv);
    assert.equal(fetched.fileSha256, job.fileSha256);
  });

  it('404s an unknown import job and 400s a malformed id', async () => {
    const db = makeDb();
    await assert.rejects(getImportJob(actor(db), 'not-a-uuid'), isError('validation.failed'));
    await assert.rejects(
      getImportJob(actor(db), 'aa000000-0000-4000-8000-0000000000b9'),
      isError('not_found', 404),
    );
  });
});

// ============ parseAssetsCsv + importAssets ============

describe('parseAssetsCsv', () => {
  it('parses a valid file, keeping the optional horometer and sede', () => {
    const parsed = parseAssetsCsv(validAssetsCsv());
    assert.equal(parsed.errors.length, 0);
    assert.deepEqual(parsed.rows[0], {
      rowNumber: 2,
      code: 'EQ-101',
      kind: 'mezcladora',
      serial: 'SN-101',
      horometer: 120.5,
      orgNodeId: null,
    });
    assert.equal(parsed.rows[1]?.horometer, null);
    assert.equal(parsed.rows[1]?.orgNodeId, NODE_B);
  });

  it('rejects a negative or non-numeric horometer as a row error', () => {
    const csv = [
      ASSETS_HEADER,
      'EQ-201,grua,SN-201,-5,',
      'EQ-202,grua,SN-202,no-numero,',
    ].join('\n');
    const parsed = parseAssetsCsv(csv);
    assert.equal(parsed.rows.length, 0);
    assert.deepEqual(
      parsed.errors.map((error) => [error.rowNumber, error.field, error.code]),
      [
        [2, 'horometer', IMPORT_ROW_ERROR.invalidHorometer],
        [3, 'horometer', IMPORT_ROW_ERROR.invalidHorometer],
      ],
    );
  });

  it('reports a missing required column as a structural 400', () => {
    assert.throws(
      () => parseAssetsCsv('code,kind\nEQ-1,grua\n'),
      isError(IMPORT_ERROR.invalidCsv),
    );
  });
});

describe('importAssets', () => {
  it('creates available assets and the initial reading when the row carries a horometer', async () => {
    const db = makeDb();
    const job = await importAssets(actor(db), importBody(validAssetsCsv()), IDEMPOTENCY_KEY);

    assert.equal(job.kind, IMPORT_KIND_ASSETS_CSV);
    assert.equal(job.rowsOk, 2);
    assert.equal(job.rowsError, 0);
    // Two of the fixtures already exist, so the map holds the two imports too.
    const imported = [...db.state.assets.values()].filter((row) => row.code === 'EQ-101' || row.code === 'EQ-102');
    assert.equal(imported.length, 2);
    for (const asset of imported) assert.equal(asset.status, 'available');
    assert.equal(db.state.readings.size, 1);
    const reading = [...db.state.readings.values()][0];
    assert.equal(reading?.kind, 'horometro');
    assert.equal(Number(reading?.value), 120.5);
    assert.equal(reading?.source, 'import');
  });

  it('counts a code repeated inside the file and a code already registered as row errors', async () => {
    const state = baseState();
    state.assets.set('dup', { id: 'dup', tenant_id: TENANT, org_node_id: NODE_A, code: 'EQ-EXIST', kind: 'grua', serial: 'S', status: 'available', current_site_id: null });
    const db = createDb(state);
    const csv = [
      ASSETS_HEADER,
      'EQ-301,grua,SN-301,,',
      'EQ-301,grua,SN-302,,',
      'EQ-EXIST,grua,SN-303,,',
    ].join('\n');
    const job = await importAssets(actor(db), importBody(csv), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 2);
    assert.match(job.errorsCsv ?? '', /import\.asset_duplicate/);
  });

  it('is idempotent by file hash for a replayed upload', async () => {
    const db = makeDb();
    const first = await importAssets(actor(db), importBody(validAssetsCsv()), IDEMPOTENCY_KEY);
    const second = await importAssets(actor(db), importBody(validAssetsCsv()), 'other-key');
    assert.equal(second.id, first.id);
    assert.equal(db.state.jobs.size, 1);
    assert.equal(db.state.readings.size, 1);
  });

  it('denies an equipment import to jefe_obra (no site.write) and audits the denial', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A, NODE_B] });
    await assert.rejects(
      importAssets(actor(db), importBody(validAssetsCsv(), SEDE), IDEMPOTENCY_KEY),
      isError('access.denied', 403),
    );
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal(denied.length, 1);
    assert.equal((denied[0]?.diff as Row).attemptedAction, 'import.assets_csv');
  });

  it('builds a downloadable errors CSV with a header and one escaped line per error', () => {
    const csv = buildErrorsCsv([
      { rowNumber: 2, field: 'code', code: 'import.asset_duplicate', message: 'a,b' },
    ]);
    assert.equal(csv, 'row,field,code,message\n2,code,import.asset_duplicate,"a,b"');
  });
});

// ============ site board (§6.2) ============

describe('getSiteBoard', () => {
  it('returns progress, attendance, critical stock, maintenance and milestones', async () => {
    const db = makeDb();
    const board: SiteBoard = await getSiteBoard(actor(db), SITE_A, DAY);

    assert.equal(board.siteId, SITE_A);
    assert.equal(board.siteCode, 'OBR-A');
    assert.equal(board.date, DAY);

    // A draft progress entry (10) is ignored: only posted counts.
    assert.deepEqual(board.progress, [
      { budgetLineId: BL_MUROS, description: 'Muros', qtyPlanned: 100, qtyDone: 40, qtyRemaining: 60, percent: 40 },
    ]);

    assert.deepEqual(board.attendance, { date: DAY, registered: 2, approved: 1, rejected: 0, adjusted: 0, total: 3 });

    assert.equal(board.criticalStock.length, 1);
    assert.deepEqual(board.criticalStock[0], {
      itemId: ITEM_CEMENTO,
      sku: 'CEM-001',
      name: 'Cemento',
      unit: 'bolsa',
      minStock: 5,
      available: 3,
    });

    assert.deepEqual(board.maintenanceAssets, [
      { assetId: ASSET_MAINT, code: 'EQ-M-1', kind: 'grua', serial: 'SN-M-1' },
    ]);

    // Only the pending milestone inside the 30-day horizon shows.
    assert.equal(board.upcomingMilestones.length, 1);
    assert.equal(board.upcomingMilestones[0]?.milestoneId, MILESTONE_DUE);
  });

  it('defaults the day to today when the query omits it', async () => {
    const db = makeDb();
    const board = await getSiteBoard(actor(db), SITE_A);
    assert.match(board.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('admits a worker with an active assignment in the site', async () => {
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([
        [
          'assign-1',
          {
            id: 'assign-1',
            tenant_id: TENANT,
            user_id: U_WORKER,
            site_id: SITE_A,
            crew_id: null,
            role_in_site: 'oficial',
            active: true,
            valid_from: '2025-01-15T00:00:00.000Z',
            valid_to: null,
          },
        ],
      ]),
    });
    const board = await getSiteBoard(actor(db, { userId: U_WORKER }), SITE_A, DAY);
    assert.equal(board.siteId, SITE_A);
  });

  it('denies a worker with no active assignment and audits the denial', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await assert.rejects(
      getSiteBoard(actor(db, { userId: U_WORKER }), SITE_A, DAY),
      isError('obra.scope_denied', 403),
    );
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal(denied.length, 1);
    assert.equal((denied[0]?.diff as Row).attemptedAction, 'site.access');
  });

  it('404s an unknown site and 400s a malformed id or date', async () => {
    const db = makeDb();
    await assert.rejects(
      getSiteBoard(actor(db), 'aa000000-0000-4000-8000-0000000000b9', DAY),
      isError('not_found', 404),
    );
    await assert.rejects(getSiteBoard(actor(db), 'not-a-uuid', DAY), isError('validation.failed'));
    await assert.rejects(getSiteBoard(actor(db), SITE_A, '02/03/2026'), isError('validation.failed'));
  });
});

// ============ company board (§6.2) ============

describe('getCompanyBoard', () => {
  it('aggregates the scoped sites and the global progress', async () => {
    const db = makeDb();
    const board: CompanyBoard = await getCompanyBoard(actor(db));

    assert.equal(board.orgNodeId, EMPRESA);
    assert.deepEqual(board.sites, { total: 2, active: 2, planned: 0, closed: 0 });
    assert.deepEqual(board.progress, { qtyPlanned: 100, qtyDone: 40, qtyRemaining: 60, percent: 40 });
  });

  it('documents the non-applicable KPIs instead of reporting a fake zero', async () => {
    const db = makeDb();
    const board = await getCompanyBoard(actor(db));
    assert.match(board.notApplicable.collections, /collections/);
    assert.match(board.notApplicable.moduleUsage, /module/);
  });

  it('denies the board to a tenant without the obras module and audits the denial', async () => {
    const db = makeDb({ modules: ['crm-core'] });
    await assert.rejects(getCompanyBoard(actor(db)), isError('access.denied', 403));
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal(denied.length, 1);
    assert.equal((denied[0]?.diff as Row).reason, 'module.inactive');
  });
});
