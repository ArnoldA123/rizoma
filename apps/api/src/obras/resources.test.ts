// Obras resources service coverage for the O3 use cases
// (bases-consolidadas-v1.md §2.4, §3.1, §3.4, §4.4): the equipment state
// machine, the insert-only asset readings, the warehouse stock with its
// posted-stock validation and non-destructive reversal, budget lines and posted
// progress, milestones decided by the clock and the draft→published site log.
// Every write is audited and every site-scoped field write needs the O2 key
// (an active assignment, or a manager whose subtree covers the site).
//
// The SQL client is a small stateful in-memory double implementing the exact
// statements `resources.service.ts` issues over synthetic tables, so the suite
// exercises the real control flow (central guard, assignment key, SQL branches,
// audit) without Postgres. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  assignAsset,
  createBudgetLine,
  createItem,
  createSiteLog,
  listAssets,
  listItems,
  listMoves,
  listProgressEntries,
  listSiteLogs,
  postProgress,
  postStockMove,
  publishSiteLog,
  recordReading,
  registerAsset,
  retireAsset,
  reverseMove,
  setMaintenance,
  setMilestone,
  type ObraActorContext,
  type ObraClient,
} from './resources.service.ts';

// ============ synthetic fixtures ============

const TENANT = 'a3000000-0000-4000-8000-0000000000a1';
const EMPRESA = 'b3000000-0000-4000-8000-000000000001';
const SEDE = 'b3000000-0000-4000-8000-000000000002';
const NODE_A = 'b3000000-0000-4000-8000-000000000003';
const NODE_B = 'b3000000-0000-4000-8000-000000000004';
const SITE_A = 'c3000000-0000-4000-8000-000000000001';
const SITE_B = 'c3000000-0000-4000-8000-000000000002';
const U_GERENTE = 'd3000000-0000-4000-8000-000000000001';
const U_JEFE = 'd3000000-0000-4000-8000-000000000002';
const U_CAPATAZ = 'd3000000-0000-4000-8000-000000000003';
const U_WORKER = 'd3000000-0000-4000-8000-000000000004';
const U_ALMACEN = 'd3000000-0000-4000-8000-000000000005';
const M_GERENTE = 'e3000000-0000-4000-8000-000000000001';
const M_JEFE = 'e3000000-0000-4000-8000-000000000002';
const M_CAPATAZ = 'e3000000-0000-4000-8000-000000000003';
const M_WORKER = 'e3000000-0000-4000-8000-000000000004';
const M_ALMACEN = 'e3000000-0000-4000-8000-000000000005';
const ASSET_AVAILABLE = 'f3000000-0000-4000-8000-000000000001';
const ASSET_ASSIGNED = 'f3000000-0000-4000-8000-000000000002';
const ASSET_MAINTENANCE = 'f3000000-0000-4000-8000-000000000003';
const ASSET_RETIRED = 'f3000000-0000-4000-8000-000000000004';
const ITEM_A = 'f3000000-0000-4000-8000-000000000011';
const ASSIGN_WORKER = 'a3000000-0000-4000-8000-0000000000aa';
const TRACE = 'trace-obras-resources';
const NOW = '2026-03-02T12:00:00.000Z';
const MODULES = ['crm-core', 'obras'];

// ============ in-memory double ============

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

type Row = Record<string, unknown>;

interface FakeState {
  callerUserId: string;
  memberships: Map<string, MembershipSpec>;
  subtree: string[];
  modules: string[];
  sites: Map<string, Row>;
  assignments: Map<string, Row>;
  assets: Map<string, Row>;
  readings: Map<string, Row>;
  items: Map<string, Row>;
  moves: Map<string, Row>;
  budgetLines: Map<string, Row>;
  progress: Map<string, Row>;
  milestones: Map<string, Row>;
  siteLogs: Map<string, Row>;
  audits: Row[];
  queries: string[];
  sequence: number;
}

interface FakeDb {
  readonly client: ObraClient;
  readonly state: FakeState;
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
    [U_CAPATAZ, spec(M_CAPATAZ, U_CAPATAZ, NODE_A, 'capataz')],
    [U_WORKER, spec(M_WORKER, U_WORKER, NODE_A, 'trabajador')],
    [U_ALMACEN, spec(M_ALMACEN, U_ALMACEN, EMPRESA, 'almacen')],
  ]);
}

function siteRow(id: string, orgNodeId: string, code: string): Row {
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
    status: 'active',
  };
}

function assetRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSET_AVAILABLE,
    tenant_id: TENANT,
    org_node_id: NODE_A,
    code: 'EQ-001',
    kind: 'mezcladora',
    serial: 'SN-001',
    status: 'available',
    current_site_id: null,
    ...overrides,
  };
}

function itemRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ITEM_A,
    tenant_id: TENANT,
    sku: 'CEM-001',
    name: 'Cemento',
    unit: 'bolsa',
    min_stock: 5,
    active: true,
    ...overrides,
  };
}

function moveRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'f3000000-0000-4000-8000-000000000021',
    tenant_id: TENANT,
    item_id: ITEM_A,
    warehouse_node_id: NODE_A,
    site_id: null,
    qty: 10,
    kind: 'in',
    at: NOW,
    status: 'posted',
    ...overrides,
  };
}

function budgetLineRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'f3000000-0000-4000-8000-000000000031',
    tenant_id: TENANT,
    site_id: SITE_A,
    item_id: null,
    description: 'Muros',
    qty_planned: 100,
    unit_cost: 25,
    active: true,
    ...overrides,
  };
}

function siteLogRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'f3000000-0000-4000-8000-000000000041',
    tenant_id: TENANT,
    site_id: SITE_A,
    author_id: U_JEFE,
    text: 'Se vació el agregado',
    attachment_ids: [],
    at: NOW,
    status: 'draft',
    ...overrides,
  };
}

function assignmentRow(overrides: Partial<Row> = {}): Row {
  return {
    id: ASSIGN_WORKER,
    tenant_id: TENANT,
    user_id: U_WORKER,
    site_id: SITE_A,
    crew_id: null,
    role_in_site: 'oficial',
    active: true,
    valid_from: '2025-01-15T00:00:00.000Z',
    valid_to: null,
    ...overrides,
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
    assets: new Map<string, Row>(),
    readings: new Map<string, Row>(),
    items: new Map<string, Row>([[ITEM_A, itemRow()]]),
    moves: new Map<string, Row>(),
    budgetLines: new Map<string, Row>(),
    progress: new Map<string, Row>(),
    milestones: new Map<string, Row>(),
    siteLogs: new Map<string, Row>(),
    audits: [],
    queries: [],
    sequence: 0,
    ...overrides,
  };
}

function inWindow(row: Row, now = NOW): boolean {
  if (row.active !== true) return false;
  if (String(row.valid_from) > now) return false;
  if (row.valid_to !== null && String(row.valid_to) < now) return false;
  return true;
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

function nextId(state: FakeState): string {
  state.sequence += 1;
  return `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
}

function uniqueViolation(): Error {
  const error = new Error('duplicate key value violates unique constraint') as Error & { code: string };
  error.code = '23505';
  return error;
}

/**
 * Stateful double: one branch per statement fragment the service issues. Branch
 * order matters where fragments share a prefix, so writes are checked before
 * the plain table reads.
 */
function createDb(state: FakeState): FakeDb {
  const client: ObraClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      state.queries.push(text);
      const v = values;

      // ---- audit (write and denial share the table) ----
      if (text.includes('INSERT INTO audit_log')) {
        if (v.length === 7) {
          state.audits.push({
            tenant_id: v[0],
            actor: v[1],
            action: 'access.denied',
            entity: v[2],
            entity_id: v[3],
            org_node_id: v[4],
            diff: JSON.parse(String(v[5])) as Row,
            ip: v[6],
          });
          return { rows: [] };
        }
        state.audits.push({
          tenant_id: v[0],
          actor: v[1],
          action: v[2],
          entity: v[3],
          entity_id: v[4],
          org_node_id: v[5],
          diff: JSON.parse(String(v[6])) as Row,
          ip: v[7],
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

      // ---- sites ----
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        const row = state.sites.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }

      // ---- assets ----
      if (text.includes('INSERT INTO assets')) {
        for (const row of state.assets.values()) {
          if (row.code === v[2]) throw uniqueViolation();
        }
        const row = assetRow({
          id: nextId(state),
          org_node_id: String(v[1]),
          code: String(v[2]),
          kind: String(v[3]),
          serial: String(v[4]),
          status: 'available',
          current_site_id: null,
        });
        state.assets.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('UPDATE assets')) {
        const row = state.assets.get(String(v[1]));
        if (row === undefined) return { rows: [] };
        if (text.includes('current_site_id = $3')) {
          if (row.status !== 'available') return { rows: [] };
          row.status = 'assigned';
          row.current_site_id = String(v[2]);
          return { rows: [row] };
        }
        if (row.status === 'retired') return { rows: [] };
        row.current_site_id = null;
        row.status = text.includes("'maintenance'") ? 'maintenance' : 'retired';
        return { rows: [row] };
      }
      if (text.includes('FROM assets WHERE tenant_id = $1 AND id = $2')) {
        const row = state.assets.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.includes('FROM assets WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = new Set((v[1] as readonly unknown[]).map(String));
        const rows = [...state.assets.values()]
          .filter((row) => scope.has(String(row.org_node_id)))
          .sort((a, b) => String(a.code).localeCompare(String(b.code)));
        return { rows };
      }
      if (text.includes('INSERT INTO asset_readings')) {
        const row: Row = {
          id: nextId(state),
          tenant_id: v[0],
          asset_id: v[1],
          kind: v[2],
          value: v[3],
          at: NOW,
          source: v[4],
        };
        state.readings.set(String(row.id), row);
        return { rows: [row] };
      }

      // ---- inventory items ----
      if (text.includes('INSERT INTO inventory_items')) {
        for (const row of state.items.values()) {
          if (row.sku === v[1]) throw uniqueViolation();
        }
        const row = itemRow({
          id: nextId(state),
          sku: String(v[1]),
          name: String(v[2]),
          unit: String(v[3]),
          min_stock: v[4],
          active: true,
        });
        state.items.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('FROM inventory_items WHERE tenant_id = $1 AND id = $2')) {
        const row = state.items.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.includes('FROM inventory_items WHERE tenant_id = $1')) {
        const rows = [...state.items.values()].sort((a, b) =>
          String(a.sku).localeCompare(String(b.sku)),
        );
        return { rows };
      }

      // ---- stock moves ----
      if (text.includes('INSERT INTO stock_moves')) {
        const row = moveRow({
          id: nextId(state),
          item_id: String(v[1]),
          warehouse_node_id: String(v[2]),
          site_id: v[3] === null || v[3] === undefined ? null : String(v[3]),
          qty: v[4],
          kind: String(v[5]),
          at: NOW,
          status: 'posted',
        });
        state.moves.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('FROM stock_moves') && text.includes('AS available')) {
        let available = 0;
        for (const row of state.moves.values()) {
          if (String(row.item_id) !== String(v[1])) continue;
          if (String(row.warehouse_node_id) !== String(v[2])) continue;
          if (row.status !== 'posted') continue;
          available += row.kind === 'in' ? Number(row.qty) : -Number(row.qty);
        }
        return { rows: [{ available }] };
      }
      if (text.includes('FROM stock_moves WHERE tenant_id = $1 AND id = $2')) {
        const row = state.moves.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.includes('FROM stock_moves WHERE tenant_id = $1 AND warehouse_node_id = ANY')) {
        const scope = new Set((v[1] as readonly unknown[]).map(String));
        const rows = [...state.moves.values()]
          .filter((row) => scope.has(String(row.warehouse_node_id)))
          .sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return { rows };
      }
      if (text.includes('UPDATE stock_moves')) {
        const row = state.moves.get(String(v[1]));
        if (row === undefined || row.status !== 'posted') return { rows: [] };
        row.status = 'reversed';
        return { rows: [row] };
      }

      // ---- budget lines ----
      if (text.includes('INSERT INTO budget_lines')) {
        const row = budgetLineRow({
          id: nextId(state),
          site_id: String(v[1]),
          item_id: v[2] === null || v[2] === undefined ? null : String(v[2]),
          description: String(v[3]),
          qty_planned: v[4],
          unit_cost: v[5],
          active: true,
        });
        state.budgetLines.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('FROM budget_lines WHERE tenant_id = $1 AND id = $2')) {
        const row = state.budgetLines.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }

      // ---- progress ----
      if (text.includes('INSERT INTO progress_entries')) {
        const row: Row = {
          id: nextId(state),
          tenant_id: v[0],
          site_id: v[1],
          budget_line_id: v[2] === null || v[2] === undefined ? null : String(v[2]),
          qty_done: v[3],
          at: NOW,
          reported_by: v[4],
          status: 'posted',
        };
        state.progress.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('FROM progress_entries WHERE tenant_id = $1 AND site_id = $2')) {
        const rows = [...state.progress.values()].filter(
          (row) => String(row.site_id) === String(v[1]),
        );
        return { rows };
      }

      // ---- milestones ----
      if (text.includes('INSERT INTO milestones')) {
        const dueAt = String(v[3]);
        const row: Row = {
          id: nextId(state),
          tenant_id: v[0],
          site_id: v[1],
          name: v[2],
          due_at: dueAt,
          status: dueAt < NOW ? 'late' : 'pending',
        };
        state.milestones.set(String(row.id), row);
        return { rows: [row] };
      }

      // ---- site logs ----
      if (text.includes('INSERT INTO site_logs')) {
        const row = siteLogRow({
          id: nextId(state),
          site_id: String(v[1]),
          author_id: v[2],
          text: String(v[3]),
          attachment_ids: v[4] ?? [],
          at: NOW,
          status: 'draft',
        });
        state.siteLogs.set(String(row.id), row);
        return { rows: [row] };
      }
      if (text.includes('UPDATE site_logs')) {
        const row = state.siteLogs.get(String(v[1]));
        if (row === undefined || row.status !== 'draft') return { rows: [] };
        row.status = 'published';
        return { rows: [row] };
      }
      if (text.includes('FROM site_logs WHERE tenant_id = $1 AND id = $2')) {
        const row = state.siteLogs.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.includes('FROM site_logs WHERE tenant_id = $1 AND site_id = $2')) {
        const rows = [...state.siteLogs.values()].filter(
          (row) => String(row.site_id) === String(v[1]),
        );
        return { rows };
      }

      // ---- assignment key (O2) ----
      if (text.includes('FROM assignments') && text.includes('user_id = $2 AND site_id = $3')) {
        for (const row of state.assignments.values()) {
          if (String(row.user_id) !== String(v[1]) || String(row.site_id) !== String(v[2])) continue;
          if (String(row.tenant_id) !== String(v[0]) || !inWindow(row)) continue;
          return { rows: [row] };
        }
        return { rows: [] };
      }

      return { rows: [] };
    },
  };
  return { client, state };
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

async function expectHttp(
  promise: Promise<unknown>,
  status: number,
  code: string,
  reason?: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
    const body = error.getResponse() as Record<string, unknown>;
    assert.equal(error.getStatus(), status);
    assert.equal(body.code, code);
    if (reason !== undefined) assert.equal(body.reason, reason);
    return true;
  });
}

function auditsOf(state: FakeState, action: string): Row[] {
  return state.audits.filter((row) => row.action === action);
}

// ============ assets: register ============

describe('registerAsset', () => {
  it('lets gerente register an available asset and audits the write', async () => {
    const db = makeDb();
    const asset = await registerAsset(actor(db), {
      orgNodeId: NODE_A,
      code: 'EQ-100',
      kind: 'mezcladora',
      serial: 'SN-100',
    });
    assert.equal(asset.status, 'available');
    assert.equal(asset.currentSiteId, null);
    assert.equal(db.state.assets.size, 1);
    const audit = auditsOf(db.state, 'asset.created');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entity, 'asset');
    assert.equal(audit[0]?.actor, U_GERENTE);
  });

  it('rejects a duplicate code with obra.duplicate', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    await expectHttp(
      registerAsset(actor(db), { orgNodeId: NODE_A, code: 'EQ-001', kind: 'k', serial: 's' }),
      409,
      'obra.duplicate',
    );
  });

  it('rejects a malformed body with validation.failed', async () => {
    const db = makeDb();
    await expectHttp(
      registerAsset(actor(db), { orgNodeId: NODE_A, kind: 'k', serial: 's' }),
      400,
      'validation.failed',
    );
  });

  it('denies jefe_obra registering an asset (no site.write)', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(
      registerAsset(actor(db), { orgNodeId: NODE_A, code: 'EQ-200', kind: 'k', serial: 's' }),
      403,
      'obra.scope_denied',
      'role.denied',
    );
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });
});

// ============ assets: assign / maintenance / retire ============

describe('assignAsset', () => {
  it('assigns an available asset to a site and audits the transition', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    const asset = await assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_A });
    assert.equal(asset.status, 'assigned');
    assert.equal(asset.currentSiteId, SITE_A);
    assert.equal(auditsOf(db.state, 'asset.assigned').length, 1);
  });

  it('answers obra.asset_unavailable for a maintenance asset', async () => {
    const row = assetRow({ status: 'maintenance' });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    await expectHttp(assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_A }), 409, 'obra.asset_unavailable', 'asset.maintenance');
  });

  it('answers obra.asset_unavailable for a retired asset', async () => {
    const row = assetRow({ status: 'retired' });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    await expectHttp(assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_A }), 409, 'obra.asset_unavailable', 'asset.retired');
  });

  it('answers obra.asset_unavailable for an already assigned asset', async () => {
    const row = assetRow({ status: 'assigned', current_site_id: SITE_A });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    await expectHttp(assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_A }), 409, 'obra.asset_unavailable', 'asset.assigned');
  });

  it('denies a capataz assigning (no assignment.write)', async () => {
    const db = makeDb({
      callerUserId: U_CAPATAZ,
      subtree: [NODE_A],
      assets: new Map([[ASSET_AVAILABLE, assetRow()]]),
    });
    await expectHttp(assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_A }), 403, 'obra.scope_denied', 'role.denied');
  });

  it('denies jefe_obra assigning outside its own site', async () => {
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      assets: new Map([[ASSET_AVAILABLE, assetRow()]]),
    });
    await expectHttp(assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_B }), 403, 'obra.scope_denied', 'scope.outside_subtree');
  });

  it('reports an unknown site as not found', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    await expectHttp(assignAsset(actor(db), ASSET_AVAILABLE, { siteId: SITE_B.replace('2', '9') }), 404, 'not_found');
  });
});

describe('setMaintenance and retireAsset', () => {
  it('sends an assigned asset to maintenance and detaches the site', async () => {
    const row = assetRow({ status: 'assigned', current_site_id: SITE_A });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    const asset = await setMaintenance(actor(db), ASSET_AVAILABLE);
    assert.equal(asset.status, 'maintenance');
    assert.equal(asset.currentSiteId, null);
    assert.equal(auditsOf(db.state, 'asset.maintenance').length, 1);
  });

  it('refuses to send a retired asset to maintenance', async () => {
    const row = assetRow({ status: 'retired' });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    await expectHttp(setMaintenance(actor(db), ASSET_AVAILABLE), 409, 'obra.asset_unavailable', 'asset.retired');
  });

  it('retires an available asset and audits the write', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    const asset = await retireAsset(actor(db), ASSET_AVAILABLE);
    assert.equal(asset.status, 'retired');
    assert.equal(auditsOf(db.state, 'asset.retired').length, 1);
  });

  it('refuses to retire an already retired asset', async () => {
    const row = assetRow({ status: 'retired' });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    await expectHttp(retireAsset(actor(db), ASSET_AVAILABLE), 409, 'obra.asset_unavailable', 'asset.retired');
  });
});

// ============ asset readings ============

describe('recordReading', () => {
  it('appends a reading and audits the write', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    const reading = await recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: 12.5 });
    assert.equal(reading.value, 12.5);
    assert.equal(reading.kind, 'horometro');
    assert.equal(reading.source, 'manual');
    assert.equal(auditsOf(db.state, 'asset_reading.recorded').length, 1);
  });

  it('is insert-only: two readings leave two rows and no update', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    await recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: 1 });
    await recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: 2 });
    assert.equal(db.state.readings.size, 2);
    assert.equal(auditsOf(db.state, 'asset_reading.recorded').length, 2);
  });

  it('lets an assigned worker read the asset at its site', async () => {
    const row = assetRow({ status: 'assigned', current_site_id: SITE_A });
    const assignment = assignmentRow();
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assets: new Map([[row.id, row]]),
      assignments: new Map([[ASSIGN_WORKER, assignment]]),
    });
    const reading = await recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: 3 });
    assert.equal(reading.assetId, ASSET_AVAILABLE);
  });

  it('denies a worker without an active assignment', async () => {
    const row = assetRow({ status: 'assigned', current_site_id: SITE_A });
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assets: new Map([[row.id, row]]),
    });
    await expectHttp(
      recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: 3 }),
      403,
      'obra.scope_denied',
      'no_active_assignment',
    );
  });

  it('refuses to read a retired asset', async () => {
    const row = assetRow({ status: 'retired' });
    const db = makeDb({ assets: new Map([[row.id, row]]) });
    await expectHttp(recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: 3 }), 409, 'obra.asset_unavailable', 'asset.retired');
  });

  it('rejects a negative reading with validation.failed', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    await expectHttp(recordReading(actor(db), ASSET_AVAILABLE, { kind: 'horometro', value: -1 }), 400, 'validation.failed');
  });
});

// ============ asset list ============

describe('listAssets', () => {
  it('lists the subtree units ordered by code', async () => {
    const inScope = assetRow({ code: 'EQ-002', org_node_id: NODE_A });
    const alsoInScope = assetRow({
      id: 'f3000000-0000-4000-8000-000000000005',
      code: 'EQ-001',
      org_node_id: SEDE,
    });
    const outOfScope = assetRow({
      id: 'f3000000-0000-4000-8000-000000000006',
      code: 'EQ-000',
      org_node_id: NODE_B,
    });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      assets: new Map([
        [inScope.id as string, inScope],
        [alsoInScope.id as string, alsoInScope],
        [outOfScope.id as string, outOfScope],
      ]),
    });
    const rows = await listAssets(actor(db));
    assert.deepEqual(
      rows.map((row) => row.code),
      ['EQ-001', 'EQ-002'],
    );
  });

  it('answers an empty list when the subtree holds no unit', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    assert.deepEqual(await listAssets(actor(db)), []);
  });

  it('denies a caller without membership and audits the denial', async () => {
    const db = makeDb({
      callerUserId: 'd3000000-0000-4000-8000-000000000099',
      memberships: new Map(),
      subtree: [],
    });
    await expectHttp(listAssets(actor(db)), 403, 'obra.scope_denied', 'membership.inactive');
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });

  it('caps the answer at 200 rows like the other list endpoints', async () => {
    const db = makeDb();
    await listAssets(actor(db));
    assert.equal(
      db.state.queries.some((text) => text.includes('LIMIT 200')),
      true,
      'the issued SQL carries the cap',
    );
  });

  it('writes no audit row on a successful read', async () => {
    const db = makeDb({ assets: new Map([[ASSET_AVAILABLE, assetRow()]]) });
    await listAssets(actor(db));
    assert.equal(db.state.audits.length, 0);
  });
});

// ============ warehouse items ============

describe('createItem', () => {
  it('lets almacen create an item and audits the write', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    const item = await createItem(actor(db), { sku: 'ARE-001', name: 'Arena', unit: 'm3' });
    assert.equal(item.sku, 'ARE-001');
    assert.equal(item.active, true);
    assert.equal(auditsOf(db.state, 'inventory_item.created').length, 1);
  });

  it('rejects a duplicate sku with obra.duplicate', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    await expectHttp(createItem(actor(db), { sku: 'CEM-001', name: 'Cemento', unit: 'bolsa' }), 409, 'obra.duplicate');
  });

  it('denies trabajador creating an item (no stock.consume)', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(createItem(actor(db), { sku: 'X-1', name: 'X', unit: 'u' }), 403, 'obra.scope_denied', 'role.denied');
  });
});

// ============ item list ============

describe('listItems', () => {
  it('lists the tenant items ordered by sku', async () => {
    const second = itemRow({ id: 'f3000000-0000-4000-8000-000000000012', sku: 'BLO-001', name: 'Bloque' });
    const db = makeDb({
      callerUserId: U_ALMACEN,
      items: new Map([
        [ITEM_A, itemRow()],
        [second.id as string, second],
      ]),
    });
    const rows = await listItems(actor(db));
    assert.deepEqual(
      rows.map((row) => row.sku),
      ['BLO-001', 'CEM-001'],
    );
  });

  it('lets a worker read the catalogue: items carry no org scope', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    const rows = await listItems(actor(db));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sku, 'CEM-001');
  });

  it('denies a caller without membership and audits the denial', async () => {
    const db = makeDb({
      callerUserId: 'd3000000-0000-4000-8000-000000000099',
      memberships: new Map(),
      subtree: [],
    });
    await expectHttp(listItems(actor(db)), 403, 'obra.scope_denied', 'membership.inactive');
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });

  it('caps the answer at 200 rows and writes no audit row on a read', async () => {
    const db = makeDb();
    await listItems(actor(db));
    assert.equal(
      db.state.queries.some((text) => text.includes('LIMIT 200')),
      true,
      'the issued SQL carries the cap',
    );
    assert.equal(db.state.audits.length, 0);
  });
});

// ============ stock moves ============

describe('postStockMove', () => {
  it('posts an inbound move without a stock check', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    const move = await postStockMove(actor(db), {
      itemId: ITEM_A,
      warehouseNodeId: NODE_A,
      qty: 10,
      kind: 'in',
    });
    assert.equal(move.status, 'posted');
    assert.equal(move.qty, 10);
    assert.equal(auditsOf(db.state, 'stock_move.posted').length, 1);
  });

  it('posts an outbound consumption and decrements the warehouse stock', async () => {
    const existing = moveRow({ id: 'f3000000-0000-4000-8000-000000000022', qty: 10, kind: 'in' });
    const db = makeDb({ callerUserId: U_ALMACEN, moves: new Map([[existing.id, existing]]) });
    const move = await postStockMove(actor(db), {
      itemId: ITEM_A,
      warehouseNodeId: NODE_A,
      siteId: SITE_A,
      qty: 4,
      kind: 'out',
    });
    assert.equal(move.status, 'posted');
    assert.equal(move.siteId, SITE_A);
    const remaining = [...db.state.moves.values()]
      .filter((row) => row.status === 'posted')
      .reduce((total, row) => total + (row.kind === 'in' ? Number(row.qty) : -Number(row.qty)), 0);
    assert.equal(remaining, 6);
  });

  it('refuses an outbound consumption above the posted stock', async () => {
    const existing = moveRow({ id: 'f3000000-0000-4000-8000-000000000023', qty: 3, kind: 'in' });
    const db = makeDb({ callerUserId: U_ALMACEN, moves: new Map([[existing.id, existing]]) });
    await expectHttp(
      postStockMove(actor(db), { itemId: ITEM_A, warehouseNodeId: NODE_A, qty: 10, kind: 'out' }),
      409,
      'obra.insufficient_stock',
    );
    assert.equal(db.state.moves.size, 1, 'no move was inserted');
  });

  it('lets a capataz post at a warehouse inside its subtree', async () => {
    const db = makeDb({ callerUserId: U_CAPATAZ, subtree: [NODE_A] });
    const move = await postStockMove(actor(db), {
      itemId: ITEM_A,
      warehouseNodeId: NODE_A,
      qty: 5,
      kind: 'in',
    });
    assert.equal(move.status, 'posted');
  });

  it('denies an almacen posting at a warehouse outside its subtree', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN, subtree: [EMPRESA] });
    await expectHttp(
      postStockMove(actor(db), { itemId: ITEM_A, warehouseNodeId: NODE_A, qty: 5, kind: 'in' }),
      403,
      'obra.scope_denied',
      'scope.outside_subtree',
    );
  });

  it('reports an unknown item as not found', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    await expectHttp(
      postStockMove(actor(db), { itemId: 'f3000000-0000-4000-8000-00000000ffff', warehouseNodeId: NODE_A, qty: 5, kind: 'in' }),
      404,
      'not_found',
    );
  });

  it('rejects a non-positive quantity with validation.failed', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    await expectHttp(
      postStockMove(actor(db), { itemId: ITEM_A, warehouseNodeId: NODE_A, qty: 0, kind: 'in' }),
      400,
      'validation.failed',
    );
  });
});

// ============ stock reversal ============

describe('reverseMove', () => {
  it('reverses a posted move without deleting the row', async () => {
    const row = moveRow();
    const db = makeDb({ callerUserId: U_ALMACEN, moves: new Map([[row.id, row]]) });
    const reversed = await reverseMove(actor(db), String(row.id));
    assert.equal(reversed.status, 'reversed');
    assert.equal(db.state.moves.size, 1, 'the original row stays');
    assert.equal(auditsOf(db.state, 'stock_move.reversed').length, 1);
  });

  it('refuses to reverse a move that is not posted', async () => {
    const row = moveRow({ status: 'draft' });
    const db = makeDb({ callerUserId: U_ALMACEN, moves: new Map([[row.id, row]]) });
    await expectHttp(reverseMove(actor(db), String(row.id)), 409, 'obra.state_denied', 'stock_move.draft');
  });

  it('refuses a reversal that would drive the stock below zero', async () => {
    const first = moveRow({ id: 'f3000000-0000-4000-8000-000000000061', qty: 10, kind: 'in' });
    const second = moveRow({ id: 'f3000000-0000-4000-8000-000000000062', qty: 5, kind: 'in' });
    const out = moveRow({ id: 'f3000000-0000-4000-8000-000000000063', qty: 12, kind: 'out' });
    const db = makeDb({
      callerUserId: U_ALMACEN,
      moves: new Map([first, second, out].map((row) => [String(row.id), row])),
    });
    await expectHttp(reverseMove(actor(db), String(first.id)), 409, 'obra.insufficient_stock');
  });

  it('reports an unknown move as not found', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    await expectHttp(reverseMove(actor(db), 'f3000000-0000-4000-8000-00000000ffff'), 404, 'not_found');
  });
});

// ============ stock move list ============

describe('listMoves', () => {
  it('lists the subtree warehouse moves, newest first', async () => {
    const older = moveRow({ id: 'f3000000-0000-4000-8000-000000000071', at: '2026-03-01T12:00:00.000Z' });
    const newer = moveRow({
      id: 'f3000000-0000-4000-8000-000000000072',
      at: '2026-03-02T12:00:00.000Z',
      kind: 'out',
      site_id: SITE_A,
    });
    const outOfScope = moveRow({
      id: 'f3000000-0000-4000-8000-000000000073',
      warehouse_node_id: NODE_B,
    });
    const db = makeDb({
      callerUserId: U_ALMACEN,
      subtree: [EMPRESA, NODE_A],
      moves: new Map([
        [older.id as string, older],
        [newer.id as string, newer],
        [outOfScope.id as string, outOfScope],
      ]),
    });
    const rows = await listMoves(actor(db));
    assert.deepEqual(
      rows.map((row) => row.id),
      [newer.id, older.id],
    );
  });

  it('answers an empty list when no subtree warehouse moved stock', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN, subtree: [EMPRESA, NODE_A] });
    assert.deepEqual(await listMoves(actor(db)), []);
  });

  it('denies a caller without membership and audits the denial', async () => {
    const db = makeDb({
      callerUserId: 'd3000000-0000-4000-8000-000000000099',
      memberships: new Map(),
      subtree: [],
    });
    await expectHttp(listMoves(actor(db)), 403, 'obra.scope_denied', 'membership.inactive');
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });

  it('caps the answer at 200 rows and writes no audit row on a read', async () => {
    const db = makeDb({ callerUserId: U_ALMACEN });
    await listMoves(actor(db));
    assert.equal(
      db.state.queries.some((text) => text.includes('LIMIT 200')),
      true,
      'the issued SQL carries the cap',
    );
    assert.equal(db.state.audits.length, 0);
  });
});

// ============ budget lines ============

describe('createBudgetLine', () => {
  it('lets gerente create a budget line and audits the write', async () => {
    const db = makeDb();
    const line = await createBudgetLine(actor(db), {
      siteId: SITE_A,
      description: 'Muros de ladrillo',
      qtyPlanned: 120,
      unitCost: 25,
    });
    assert.equal(line.siteId, SITE_A);
    assert.equal(line.qtyPlanned, 120);
    assert.equal(auditsOf(db.state, 'budget_line.created').length, 1);
  });

  it('denies jefe_obra creating a budget line (no site.write)', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(
      createBudgetLine(actor(db), { siteId: SITE_A, description: 'x' }),
      403,
      'obra.scope_denied',
      'role.denied',
    );
  });

  it('rejects a malformed body with validation.failed', async () => {
    const db = makeDb();
    await expectHttp(createBudgetLine(actor(db), { siteId: SITE_A }), 400, 'validation.failed');
  });
});

// ============ progress ============

describe('postProgress', () => {
  it('lets jefe_obra post progress and audits the write', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    const entry = await postProgress(actor(db), { siteId: SITE_A, qtyDone: 30 });
    assert.equal(entry.status, 'posted');
    assert.equal(entry.qtyDone, 30);
    assert.equal(entry.reportedBy, U_JEFE);
    assert.equal(auditsOf(db.state, 'progress_entry.posted').length, 1);
  });

  it('adds up the posted qty_done of a site', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await postProgress(actor(db), { siteId: SITE_A, qtyDone: 30 });
    await postProgress(actor(db), { siteId: SITE_A, qtyDone: 12.5 });
    const entries = await listProgressEntries(actor(db), SITE_A);
    const total = entries.reduce((sum, row) => sum + row.qtyDone, 0);
    assert.equal(entries.length, 2);
    assert.equal(total, 42.5);
  });

  it('denies a worker without an active assignment', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(postProgress(actor(db), { siteId: SITE_A, qtyDone: 5 }), 403, 'obra.scope_denied', 'no_active_assignment');
  });

  it('rejects a budget line belonging to another site', async () => {
    const line = budgetLineRow({ site_id: SITE_B });
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A], budgetLines: new Map([[String(line.id), line]]) });
    await expectHttp(postProgress(actor(db), { siteId: SITE_A, budgetLineId: String(line.id), qtyDone: 5 }), 400, 'validation.failed');
  });

  it('reports an unknown budget line as not found', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(
      postProgress(actor(db), { siteId: SITE_A, budgetLineId: 'f3000000-0000-4000-8000-00000000ffff', qtyDone: 5 }),
      404,
      'not_found',
    );
  });
});

// ============ milestones ============

describe('setMilestone', () => {
  it('stores a future milestone as pending', async () => {
    const db = makeDb();
    const milestone = await setMilestone(actor(db), {
      siteId: SITE_A,
      name: 'Techo vaciado',
      dueAt: '2026-04-01T00:00:00.000Z',
    });
    assert.equal(milestone.status, 'pending');
    assert.equal(auditsOf(db.state, 'milestone.set').length, 1);
  });

  it('stores a milestone already due as late', async () => {
    const db = makeDb();
    const milestone = await setMilestone(actor(db), {
      siteId: SITE_A,
      name: 'Cimentación',
      dueAt: '2026-02-01T00:00:00.000Z',
    });
    assert.equal(milestone.status, 'late');
  });

  it('denies jefe_obra setting a milestone (no site.write)', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(
      setMilestone(actor(db), { siteId: SITE_A, name: 'x', dueAt: '2026-04-01T00:00:00.000Z' }),
      403,
      'obra.scope_denied',
      'role.denied',
    );
  });
});

// ============ site log ============

describe('createSiteLog', () => {
  it('lets jefe_obra append a draft log and audits the write', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    const log = await createSiteLog(actor(db), SITE_A, { text: 'Se vació el agregado' });
    assert.equal(log.status, 'draft');
    assert.equal(log.authorId, U_JEFE);
    assert.equal(log.siteId, SITE_A);
    assert.equal(auditsOf(db.state, 'site_log.created').length, 1);
  });

  it('denies a worker without an active assignment', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(createSiteLog(actor(db), SITE_A, { text: 'x' }), 403, 'obra.scope_denied', 'no_active_assignment');
  });

  it('rejects a non-uuid attachment with validation.failed', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(createSiteLog(actor(db), SITE_A, { text: 'x', attachmentIds: ['nope'] }), 400, 'validation.failed');
  });
});

describe('publishSiteLog', () => {
  it('publishes a draft log and audits the transition', async () => {
    const row = siteLogRow();
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      siteLogs: new Map([[String(row.id), row]]),
    });
    const log = await publishSiteLog(actor(db), SITE_A, String(row.id));
    assert.equal(log.status, 'published');
    assert.equal(auditsOf(db.state, 'site_log.published').length, 1);
  });

  it('refuses to publish a log that is not a draft', async () => {
    const row = siteLogRow({ status: 'published' });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      siteLogs: new Map([[String(row.id), row]]),
    });
    await expectHttp(publishSiteLog(actor(db), SITE_A, String(row.id)), 409, 'obra.state_denied', 'site_log.published');
  });

  it('reports an unknown log as not found', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(publishSiteLog(actor(db), SITE_A, 'f3000000-0000-4000-8000-00000000ffff'), 404, 'not_found');
  });

  it('lists the logs of a site', async () => {
    const first = siteLogRow({ id: 'f3000000-0000-4000-8000-000000000051' });
    const second = siteLogRow({ id: 'f3000000-0000-4000-8000-000000000052', site_id: SITE_B });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      siteLogs: new Map([first, second].map((row) => [String(row.id), row])),
    });
    const logs = await listSiteLogs(actor(db), SITE_A);
    assert.deepEqual(logs.map((row) => row.id), [String(first.id)]);
  });
});
