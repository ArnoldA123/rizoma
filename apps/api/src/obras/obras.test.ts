// Obras service coverage for the construction access model
// (bases-consolidadas-v1.md §2.4, §3.1, §3.4, §3.5): the active assignment is
// the access key, a manager reaches its own sites through the membership
// subtree, a closed assignment or an expired window cuts access at once, a
// worker marks only itself, `almacen` never approves and a `jefe_obra` cannot
// approve outside its own sites.
//
// The SQL client is a small stateful in-memory double: it implements the exact
// statements `obras.service.ts` issues over a set of synthetic tables, so the
// suite exercises the real control flow (central guard, assignment key, audit)
// without Postgres. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  activeAssignment,
  approveAttendance,
  assignWorker,
  closeAssignment,
  createSite,
  dayAttendance,
  getSite,
  listSiteStaff,
  listSites,
  markAttendance,
  requireSiteAccess,
  type ObraActorContext,
  type ObraClient,
} from './obras.service.ts';

// ============ synthetic fixtures ============

const TENANT = 'a2000000-0000-4000-8000-0000000000a1';
const EMPRESA = 'b2000000-0000-4000-8000-000000000001';
const SEDE = 'b2000000-0000-4000-8000-000000000002';
const NODE_A = 'b2000000-0000-4000-8000-000000000003';
const NODE_B = 'b2000000-0000-4000-8000-000000000004';
const SITE_A = 'c2000000-0000-4000-8000-000000000001';
const SITE_B = 'c2000000-0000-4000-8000-000000000002';
const U_GERENTE = 'd2000000-0000-4000-8000-000000000001';
const U_JEFE = 'd2000000-0000-4000-8000-000000000002';
const U_CAPATAZ = 'd2000000-0000-4000-8000-000000000003';
const U_WORKER = 'd2000000-0000-4000-8000-000000000004';
const U_WORKER2 = 'd2000000-0000-4000-8000-000000000005';
const U_ALMACEN = 'd2000000-0000-4000-8000-000000000006';
const M_GERENTE = 'e2000000-0000-4000-8000-000000000001';
const M_JEFE = 'e2000000-0000-4000-8000-000000000002';
const M_CAPATAZ = 'e2000000-0000-4000-8000-000000000003';
const M_WORKER = 'e2000000-0000-4000-8000-000000000004';
const M_WORKER2 = 'e2000000-0000-4000-8000-000000000005';
const M_ALMACEN = 'e2000000-0000-4000-8000-000000000006';
const CREW_A = 'f2000000-0000-4000-8000-000000000001';
const TRACE = 'trace-obras-unit';
const NOW = '2026-03-02T12:00:00.000Z';
const DAY = '2026-03-02';
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

interface AssignmentRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  site_id: string;
  crew_id: string | null;
  role_in_site: string;
  active: boolean;
  valid_from: string;
  valid_to: string | null;
}

interface AttendanceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  site_id: string;
  check_in: string;
  check_out: string | null;
  source: string;
  status: string;
  approved_by: string | null;
}

interface FakeState {
  callerUserId: string;
  memberships: Map<string, MembershipSpec>;
  subtree: string[];
  modules: string[];
  sites: Map<string, Record<string, unknown>>;
  assignments: Map<string, AssignmentRow>;
  attendance: Map<string, AttendanceRow>;
  crews: Map<string, Record<string, unknown>>;
  users: Map<string, string>;
  audits: Record<string, unknown>[];
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
    [U_WORKER2, spec(M_WORKER2, U_WORKER2, NODE_A, 'trabajador')],
    [U_ALMACEN, spec(M_ALMACEN, U_ALMACEN, EMPRESA, 'almacen')],
  ]);
}

function siteRow(id: string, orgNodeId: string, code: string): Record<string, unknown> {
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

function assignmentRow(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: 'a1000000-0000-4000-8000-0000000000aa',
    tenant_id: TENANT,
    user_id: U_WORKER,
    site_id: SITE_A,
    crew_id: null,
    role_in_site: 'oficial',
    active: true,
    valid_from: '2025-01-15T00:00:00.000Z',
    valid_to: null,
    ...overrides,
  } as AssignmentRow;
}

function attendanceRow(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: 'b1000000-0000-4000-8000-0000000000bb',
    tenant_id: TENANT,
    user_id: U_WORKER,
    site_id: SITE_A,
    check_in: `${DAY}T08:05:00.000Z`,
    check_out: null,
    source: 'web',
    status: 'registered',
    approved_by: null,
    ...overrides,
  } as AttendanceRow;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    callerUserId: U_GERENTE,
    memberships: defaultMemberships(),
    subtree: [EMPRESA, SEDE, NODE_A, NODE_B],
    modules: MODULES,
    sites: new Map<string, Record<string, unknown>>([
      [SITE_A, siteRow(SITE_A, NODE_A, 'OBR-A')],
      [SITE_B, siteRow(SITE_B, NODE_B, 'OBR-B')],
    ]),
    assignments: new Map<string, AssignmentRow>(),
    attendance: new Map<string, AttendanceRow>(),
    crews: new Map<string, Record<string, unknown>>([
      [
        CREW_A,
        {
          id: CREW_A,
          tenant_id: TENANT,
          org_node_id: NODE_A,
          name: 'Cuadrilla A',
          lead_membership_id: M_CAPATAZ,
          active: true,
        },
      ],
    ]),
    users: new Map<string, string>([
      [U_WORKER, 'Worker Uno'],
      [U_WORKER2, 'Worker Dos'],
    ]),
    audits: [],
    sequence: 0,
    ...overrides,
  };
}

function inWindow(row: AssignmentRow, now = NOW): boolean {
  if (row.active !== true) return false;
  if (String(row.valid_from) > now) return false;
  if (row.valid_to !== null && String(row.valid_to) < now) return false;
  return true;
}

function membershipRow(record: MembershipSpec): Record<string, unknown> {
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

/**
 * Stateful double: one branch per statement fragment the service issues. Branch
 * order matters where fragments share a prefix, so the write branches are
 * checked before the read branches and the joins before the plain table reads.
 */
function createDb(state: FakeState): FakeDb {
  const client: ObraClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
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
            diff: JSON.parse(String(v[5])) as Record<string, unknown>,
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
          diff: JSON.parse(String(v[6])) as Record<string, unknown>,
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
      if (text.includes('INSERT INTO sites')) {
        const [, orgNodeId, code, name, clientName, budgetTotal, status] = v;
        for (const row of state.sites.values()) {
          if (row.code === code) {
            const error = new Error('duplicate key value violates unique constraint') as Error & {
              code: string;
            };
            error.code = '23505';
            throw error;
          }
        }
        state.sequence += 1;
        const id = `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
        const row = {
          id,
          tenant_id: v[0],
          org_node_id: orgNodeId,
          code,
          name,
          client_name: clientName,
          budget_total: budgetTotal,
          started_at: NOW,
          ended_at: null,
          status,
        };
        state.sites.set(id, row);
        return { rows: [row] };
      }
      if (text.includes('FROM sites WHERE tenant_id = $1 AND id = $2')) {
        const row = state.sites.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.includes('FROM sites WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = v[1] as string[];
        return { rows: [...state.sites.values()].filter((row) => scope.includes(String(row.org_node_id))) };
      }

      // ---- assignments ----
      if (text.includes('INSERT INTO assignments')) {
        state.sequence += 1;
        const id = `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
        const row = assignmentRow({
          id,
          user_id: String(v[1]),
          site_id: String(v[2]),
          crew_id: v[3] === null || v[3] === undefined ? null : String(v[3]),
          role_in_site: String(v[4]),
          active: true,
          valid_from: NOW,
          valid_to: null,
        });
        state.assignments.set(id, row);
        return { rows: [row] };
      }
      if (text.includes('UPDATE assignments')) {
        const row = state.assignments.get(String(v[1]));
        if (row === undefined) return { rows: [] };
        row.active = false;
        row.valid_to = NOW;
        return { rows: [row] };
      }
      if (text.includes('FROM assignments a') && text.includes('user_name')) {
        const rows: Record<string, unknown>[] = [];
        for (const row of state.assignments.values()) {
          if (String(row.site_id) !== String(v[1]) || !inWindow(row)) continue;
          const crew = row.crew_id === null ? undefined : state.crews.get(row.crew_id);
          rows.push({
            ...row,
            user_name: state.users.get(String(row.user_id)) ?? '',
            crew_name: crew === undefined ? null : crew.name,
          });
        }
        return { rows };
      }
      if (text.includes('FROM assignments a') && text.includes('JOIN crews')) {
        const [tenantId, workerId, siteId, membershipId] = v;
        for (const row of state.assignments.values()) {
          if (String(row.user_id) !== workerId || String(row.site_id) !== siteId) continue;
          if (String(row.tenant_id) !== tenantId || !inWindow(row)) continue;
          const crew = row.crew_id === null ? undefined : state.crews.get(row.crew_id);
          if (crew !== undefined && crew.active === true && crew.lead_membership_id === membershipId) {
            return { rows: [{ crew_id: row.crew_id }] };
          }
        }
        return { rows: [] };
      }
      if (text.includes('FROM assignments') && text.includes('user_id = $2 AND site_id = $3')) {
        for (const row of state.assignments.values()) {
          if (String(row.user_id) !== String(v[1]) || String(row.site_id) !== String(v[2])) continue;
          if (String(row.tenant_id) !== String(v[0]) || !inWindow(row)) continue;
          return { rows: [row] };
        }
        return { rows: [] };
      }

      // ---- attendance ----
      if (text.includes('INSERT INTO attendance')) {
        state.sequence += 1;
        const id = `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
        const row = attendanceRow({
          id,
          user_id: String(v[1]),
          site_id: String(v[2]),
          check_in: NOW,
          source: String(v[3]),
          status: 'registered',
          approved_by: null,
        });
        state.attendance.set(id, row);
        return { rows: [row] };
      }
      if (text.includes('UPDATE attendance')) {
        const row = state.attendance.get(String(v[1]));
        if (row === undefined || row.status !== 'registered') return { rows: [] };
        row.status = 'approved';
        row.approved_by = String(v[2]);
        return { rows: [row] };
      }
      if (text.includes('FROM attendance WHERE tenant_id = $1 AND id = $2')) {
        const row = state.attendance.get(String(v[1]));
        return { rows: row === undefined ? [] : [row] };
      }
      if (text.includes('FROM attendance') && text.includes('check_in >=')) {
        const date = String(v[2]);
        const rows = [...state.attendance.values()].filter(
          (row) => String(row.site_id) === String(v[1]) && String(row.check_in).startsWith(date),
        );
        return { rows };
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

function auditsOf(state: FakeState, action: string): Record<string, unknown>[] {
  return state.audits.filter((row) => row.action === action);
}

// ============ assignment key ============

describe('active assignment key', () => {
  it('returns the assignment while the row is active and inside its window', async () => {
    const db = makeDb({
      assignments: new Map([[assignmentRow().id, assignmentRow()]]),
    });
    const assignment = await activeAssignment(actor(db), U_WORKER, SITE_A);
    assert.equal(assignment?.id, assignmentRow().id);
    assert.equal(assignment?.roleInSite, 'oficial');
  });

  it('returns null once the assignment is closed', async () => {
    const closed = assignmentRow({ active: false, valid_to: '2026-02-01T00:00:00.000Z' });
    const db = makeDb({ assignments: new Map([[closed.id, closed]]) });
    assert.equal(await activeAssignment(actor(db), U_WORKER, SITE_A), null);
  });

  it('returns null once the validity window has expired', async () => {
    const expired = assignmentRow({ valid_to: '2026-02-01T00:00:00.000Z' });
    const db = makeDb({ assignments: new Map([[expired.id, expired]]) });
    assert.equal(await activeAssignment(actor(db), U_WORKER, SITE_A), null);
  });

  it('returns null for another user or another site', async () => {
    const db = makeDb({ assignments: new Map([[assignmentRow().id, assignmentRow()]]) });
    assert.equal(await activeAssignment(actor(db), U_WORKER2, SITE_A), null);
    assert.equal(await activeAssignment(actor(db), U_WORKER, SITE_B), null);
  });
});

describe('requireSiteAccess', () => {
  it('admits a worker with an active assignment in the site', async () => {
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([[assignmentRow().id, assignmentRow()]]),
    });
    const site = await requireSiteAccess(actor(db), U_WORKER, SITE_A);
    assert.equal(site.id, SITE_A);
  });

  it('denies a worker with no assignment with obra.scope_denied', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(requireSiteAccess(actor(db), U_WORKER, SITE_A), 403, 'obra.scope_denied', 'no_active_assignment');
  });

  it('cuts access as soon as the assignment is closed', async () => {
    const closed = assignmentRow({ active: false, valid_to: NOW });
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([[closed.id, closed]]),
    });
    await expectHttp(requireSiteAccess(actor(db), U_WORKER, SITE_A), 403, 'obra.scope_denied', 'no_active_assignment');
  });

  it('cuts access when the assignment window has expired', async () => {
    const expired = assignmentRow({ valid_to: '2026-02-01T00:00:00.000Z' });
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([[expired.id, expired]]),
    });
    await expectHttp(requireSiteAccess(actor(db), U_WORKER, SITE_A), 403, 'obra.scope_denied', 'no_active_assignment');
  });

  it('admits gerente without an assignment when the site is inside the company subtree', async () => {
    const db = makeDb();
    const site = await requireSiteAccess(actor(db), U_GERENTE, SITE_A);
    assert.equal(site.id, SITE_A);
  });

  it('admits jefe_obra without an assignment inside its own site', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    const site = await requireSiteAccess(actor(db), U_JEFE, SITE_A);
    assert.equal(site.id, SITE_A);
  });

  it('denies a manager acting outside its subtree', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(requireSiteAccess(actor(db), U_JEFE, SITE_B), 403, 'obra.scope_denied', 'scope.outside_subtree');
  });

  it('denies a member whose membership was revoked', async () => {
    const memberships = defaultMemberships();
    memberships.set(U_WORKER, spec(M_WORKER, U_WORKER, NODE_A, 'trabajador', { active: false }));
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      memberships,
      assignments: new Map([[assignmentRow().id, assignmentRow()]]),
    });
    await expectHttp(requireSiteAccess(actor(db), U_WORKER, SITE_A), 403, 'obra.scope_denied', 'membership.inactive');
  });

  it('denies a user given a baja', async () => {
    const memberships = defaultMemberships();
    memberships.set(U_WORKER, spec(M_WORKER, U_WORKER, NODE_A, 'trabajador', { userActive: false }));
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      memberships,
      assignments: new Map([[assignmentRow().id, assignmentRow()]]),
    });
    await expectHttp(requireSiteAccess(actor(db), U_WORKER, SITE_A), 403, 'obra.scope_denied', 'user.inactive');
  });

  it('denies access when the obras module is not active for the tenant', async () => {
    const db = makeDb({ modules: ['crm-core'] });
    await expectHttp(requireSiteAccess(actor(db), U_GERENTE, SITE_A), 403, 'obra.scope_denied', 'module.inactive');
  });

  it('reports an unknown site as not found', async () => {
    const db = makeDb();
    await expectHttp(requireSiteAccess(actor(db), U_GERENTE, SITE_B.replace('2', '9')), 404, 'not_found');
  });
});

// ============ sites ============

describe('createSite', () => {
  it('lets gerente create a site and audits the write', async () => {
    const db = makeDb();
    const site = await createSite(actor(db), {
      orgNodeId: NODE_A,
      code: 'OBR-NEW',
      name: 'Obra Nueva',
      clientName: 'Cliente Ficticio',
    });
    assert.equal(site.code, 'OBR-NEW');
    assert.equal(site.status, 'planned');
    const audit = auditsOf(db.state, 'site.created');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entity, 'site');
    assert.equal(audit[0]?.actor, U_GERENTE);
  });

  it('denies jefe_obra creating a site', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(
      createSite(actor(db), { orgNodeId: NODE_A, code: 'OBR-X', name: 'X', clientName: 'C' }),
      403,
      'obra.scope_denied',
      'role.denied',
    );
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });

  it('rejects a duplicate code with obra.duplicate', async () => {
    const db = makeDb();
    await expectHttp(
      createSite(actor(db), { orgNodeId: NODE_A, code: 'OBR-A', name: 'X', clientName: 'C' }),
      409,
      'obra.duplicate',
    );
  });

  it('rejects a malformed body with validation.failed', async () => {
    const db = makeDb();
    await expectHttp(createSite(actor(db), { orgNodeId: NODE_A, name: 'Sin código' }), 400, 'validation.failed');
  });
});

describe('site reads', () => {
  it('lists the sites inside the membership subtree', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    const sites = await listSites(actor(db));
    assert.deepEqual(sites.map((site) => site.id), [SITE_A]);
  });

  it('denies a role without site.read', async () => {
    const memberships = defaultMemberships();
    memberships.set(U_WORKER, spec(M_WORKER, U_WORKER, NODE_A, 'soporte'));
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A], memberships });
    await expectHttp(listSites(actor(db)), 403, 'obra.scope_denied', 'role.denied');
  });

  it('reads one site by id', async () => {
    const db = makeDb();
    const site = await getSite(actor(db), SITE_A);
    assert.equal(site.code, 'OBR-A');
  });
});

// ============ assignments ============

describe('assignWorker', () => {
  it('lets gerente assign a worker with an active membership', async () => {
    const db = makeDb();
    const assignment = await assignWorker(actor(db), SITE_A, {
      userId: U_WORKER,
      roleInSite: 'oficial',
    });
    assert.equal(assignment.userId, U_WORKER);
    assert.equal(assignment.active, true);
    assert.equal(auditsOf(db.state, 'assignment.created').length, 1);
  });

  it('lets jefe_obra assign inside its own site', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    const assignment = await assignWorker(actor(db), SITE_A, {
      userId: U_WORKER,
      crewId: CREW_A,
      roleInSite: 'ayudante',
    });
    assert.equal(assignment.userId, U_WORKER);
    assert.equal(assignment.crewId, CREW_A);
  });

  it('denies jefe_obra assigning outside its own site', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(
      assignWorker(actor(db), SITE_B, { userId: U_WORKER, roleInSite: 'oficial' }),
      403,
      'obra.scope_denied',
      'scope.outside_subtree',
    );
  });

  it('denies a capataz assigning workers', async () => {
    const db = makeDb({ callerUserId: U_CAPATAZ, subtree: [NODE_A] });
    await expectHttp(
      assignWorker(actor(db), SITE_A, { userId: U_WORKER, roleInSite: 'oficial' }),
      403,
      'obra.scope_denied',
      'role.denied',
    );
  });

  it('requires an active membership on the target user', async () => {
    const db = makeDb();
    await expectHttp(
      assignWorker(actor(db), SITE_A, {
        userId: 'd2000000-0000-4000-8000-0000000000ff',
        roleInSite: 'oficial',
      }),
      400,
      'obra.membership_required',
    );
  });

  it('is idempotent by user + site: a second call returns the live assignment', async () => {
    const existing = assignmentRow();
    const db = makeDb({ assignments: new Map([[existing.id, existing]]) });
    const assignment = await assignWorker(actor(db), SITE_A, {
      userId: U_WORKER,
      roleInSite: 'oficial',
    });
    assert.equal(assignment.id, existing.id);
    assert.equal(db.state.assignments.size, 1, 'no duplicate row');
    assert.equal(auditsOf(db.state, 'assignment.created').length, 0, 'no second write audit');
  });
});

describe('closeAssignment', () => {
  it('ends the assignment and audits the write', async () => {
    const existing = assignmentRow();
    const db = makeDb({ assignments: new Map([[existing.id, existing]]) });
    const closed = await closeAssignment(actor(db), SITE_A, U_WORKER);
    assert.equal(closed.active, false);
    assert.notEqual(closed.validTo, null);
    assert.equal(auditsOf(db.state, 'assignment.closed').length, 1);
    assert.equal(await activeAssignment(actor(db), U_WORKER, SITE_A), null);
  });

  it('reports a missing assignment as not found', async () => {
    const db = makeDb();
    await expectHttp(closeAssignment(actor(db), SITE_A, U_WORKER), 404, 'not_found');
  });
});

// ============ attendance ============

describe('markAttendance', () => {
  it('lets a worker mark its own attendance when assigned', async () => {
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([[assignmentRow().id, assignmentRow()]]),
    });
    const attendance = await markAttendance(actor(db), { siteId: SITE_A });
    assert.equal(attendance.userId, U_WORKER);
    assert.equal(attendance.status, 'registered');
    assert.equal(auditsOf(db.state, 'attendance.marked').length, 1);
  });

  it('denies marking attendance for another user', async () => {
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([[assignmentRow().id, assignmentRow()]]),
    });
    await expectHttp(
      markAttendance(actor(db), { siteId: SITE_A, userId: U_WORKER2 }),
      403,
      'obra.access_denied',
      'attendance.not_own',
    );
  });

  it('denies a worker with no active assignment', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(
      markAttendance(actor(db), { siteId: SITE_A }),
      403,
      'obra.access_denied',
      'no_active_assignment',
    );
  });

  it('denies a worker whose assignment window expired', async () => {
    const expired = assignmentRow({ valid_to: '2026-02-01T00:00:00.000Z' });
    const db = makeDb({
      callerUserId: U_WORKER,
      subtree: [NODE_A],
      assignments: new Map([[expired.id, expired]]),
    });
    await expectHttp(
      markAttendance(actor(db), { siteId: SITE_A }),
      403,
      'obra.access_denied',
      'no_active_assignment',
    );
  });
});

describe('approveAttendance', () => {
  function withAttendance(overrides: Partial<FakeState> = {}): FakeDb {
    const row = attendanceRow();
    return makeDb({ attendance: new Map([[row.id, row]]), ...overrides });
  }

  it('lets a capataz approve a mark of its own crew', async () => {
    const assignment = assignmentRow({ crew_id: CREW_A });
    const db = withAttendance({
      callerUserId: U_CAPATAZ,
      subtree: [NODE_A],
      assignments: new Map([[assignment.id, assignment]]),
    });
    const approved = await approveAttendance(actor(db), attendanceRow().id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, U_CAPATAZ);
    assert.equal(auditsOf(db.state, 'attendance.approved').length, 1);
  });

  it('denies a capataz approving a mark outside its crew', async () => {
    const assignment = assignmentRow({ crew_id: null });
    const db = withAttendance({
      callerUserId: U_CAPATAZ,
      subtree: [NODE_A],
      assignments: new Map([[assignment.id, assignment]]),
    });
    await expectHttp(approveAttendance(actor(db), attendanceRow().id), 403, 'obra.approve_denied', 'crew.mismatch');
  });

  it('never lets almacen approve', async () => {
    const db = withAttendance({ callerUserId: U_ALMACEN });
    await expectHttp(approveAttendance(actor(db), attendanceRow().id), 403, 'obra.approve_denied', 'role.denied');
  });

  it('never lets a trabajador approve', async () => {
    const db = withAttendance({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(approveAttendance(actor(db), attendanceRow().id), 403, 'obra.approve_denied', 'role.denied');
  });

  it('lets jefe_obra approve inside its own site', async () => {
    const db = withAttendance({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    const approved = await approveAttendance(actor(db), attendanceRow().id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedBy, U_JEFE);
  });

  it('denies jefe_obra approving another site', async () => {
    const other = attendanceRow({ site_id: SITE_B });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      attendance: new Map([[other.id, other]]),
    });
    await expectHttp(approveAttendance(actor(db), other.id), 403, 'obra.approve_denied', 'scope.outside_subtree');
  });

  it('refuses to approve a mark that is not registered', async () => {
    const approved = attendanceRow({ status: 'approved', approved_by: U_JEFE });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      attendance: new Map([[approved.id, approved]]),
    });
    await expectHttp(approveAttendance(actor(db), approved.id), 403, 'obra.approve_denied', 'state.denied');
  });
});

describe('attendance reads', () => {
  it('lists only the active assignments of a site', async () => {
    const live = assignmentRow({ id: 'a1000000-0000-4000-8000-0000000000aa' });
    const second = assignmentRow({ id: 'a1000000-0000-4000-8000-0000000000ab', user_id: U_WORKER2 });
    const closed = assignmentRow({
      id: 'a1000000-0000-4000-8000-0000000000ac',
      user_id: U_WORKER2,
      active: false,
      valid_to: '2026-02-01T00:00:00.000Z',
    });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      assignments: new Map([
        [live.id, live],
        [second.id, second],
        [closed.id, closed],
      ]),
    });
    const staff = await listSiteStaff(actor(db), SITE_A);
    assert.deepEqual(
      staff.map((row) => row.userId).sort(),
      [U_WORKER, U_WORKER2],
    );
    assert.equal(staff.find((row) => row.userId === U_WORKER)?.userName, 'Worker Uno');
  });

  it('denies an unassigned worker reading the site staff', async () => {
    const db = makeDb({ callerUserId: U_WORKER, subtree: [NODE_A] });
    await expectHttp(listSiteStaff(actor(db), SITE_A), 403, 'obra.scope_denied', 'no_active_assignment');
  });

  it('returns the marks of one day at one site', async () => {
    const today = attendanceRow({ id: 'b1000000-0000-4000-8000-0000000000b1' });
    const otherDay = attendanceRow({
      id: 'b1000000-0000-4000-8000-0000000000b2',
      check_in: '2026-03-03T08:05:00.000Z',
    });
    const db = makeDb({
      callerUserId: U_JEFE,
      subtree: [SEDE, NODE_A],
      attendance: new Map([
        [today.id, today],
        [otherDay.id, otherDay],
      ]),
    });
    const marks = await dayAttendance(actor(db), SITE_A, DAY);
    assert.deepEqual(marks.map((row) => row.id), [today.id]);
  });

  it('rejects a malformed date', async () => {
    const db = makeDb({ callerUserId: U_JEFE, subtree: [SEDE, NODE_A] });
    await expectHttp(dayAttendance(actor(db), SITE_A, '02-03-2026'), 400, 'validation.failed');
  });
});
