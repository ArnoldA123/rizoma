// Denial matrix coverage for the wired access guard
// (bases-consolidadas-v1.md §3.5) and the `memberships` read helper.
//
// The audit client is an in-memory double: it records every statement so the
// suite can assert that an `access.denied` row is written exactly when the rule
// denies, with the trace id, and that an allowed request writes nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  ACCESS_DENIED_ACTION,
  canActivate,
  loadMembership,
  mapMembershipRow,
  type AuditClient,
  type GuardContext,
  type MembershipRecord,
} from './access.guard.ts';
import type { Identity } from './jwt.ts';
import { listAppointments, listEpisodes, listPatients } from '../salud/salud.service.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const USER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = '2026-09-24T12:00:00-05:00';

const IDENTITY: Identity = {
  sub: USER_ID,
  tenantId: TENANT_ID,
  roles: ['caja'],
  scope: ['crm-core'],
};

const MEMBERSHIP: MembershipRecord = {
  id: 'mem-1',
  userId: USER_ID,
  tenantId: TENANT_ID,
  orgNodeId: 'org-sede-a',
  role: 'caja',
  scopes: ['crm-core'],
  active: true,
  validFrom: '2026-01-01T00:00:00-05:00',
  validTo: null,
};

interface RecordedQuery {
  readonly text: string;
  readonly values?: readonly unknown[];
}

interface FakeClientState {
  readonly client: AuditClient;
  readonly queries: RecordedQuery[];
  fail(): void;
}

/** In-memory client double: records statements, can be made to fail. */
function createFakeClient(result: unknown = { rows: [] }): FakeClientState {
  const queries: RecordedQuery[] = [];
  let failNext = false;
  const client: AuditClient = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (failNext) throw new Error('audit insert failed');
      return result;
    },
  };
  return { client, queries, fail: () => { failNext = true; } };
}

/** Full guard context over a fake audit client. */
function context(
  state: FakeClientState,
  overrides: Partial<Omit<GuardContext, 'audit'>> = {},
  audit: Partial<GuardContext['audit']> = {},
): GuardContext {
  return {
    identity: IDENTITY,
    membership: MEMBERSHIP,
    entityOrgNodeId: 'org-sede-a',
    scopeSubtree: ['org-empresa', 'org-sede-a'],
    rolePermits: true,
    stateAllows: true,
    moduleActive: true,
    now: NOW,
    ...overrides,
    audit: {
      client: state.client,
      traceId: 'trace-42',
      entity: 'patient_file',
      attemptedAction: 'patient_file.open',
      ...audit,
    },
  };
}

describe('canActivate', () => {
  it('allows a fully valid request and writes nothing', async () => {
    const state = createFakeClient();
    const decision = await canActivate(context(state));

    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'allow');
    assert.deepEqual(state.queries, [], 'an allowed request is not audited');
  });

  it('audits recepcion opening a clinical history -> role.denied', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { rolePermits: false }));
    assert.equal((await readDecision(state, 'role.denied')).allow, false);
  });

  it('audits a medico with an inactive membership -> membership.inactive', async () => {
    const state = createFakeClient();
    await canActivate(
      context(state, { membership: { ...MEMBERSHIP, active: false } }),
    );
    await readDecision(state, 'membership.inactive');
  });

  it('audits an offboarded user with a live token -> user.inactive', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { userActive: false }));
    await readDecision(state, 'user.inactive');
  });

  it('audits an expired membership -> membership.expired', async () => {
    const state = createFakeClient();
    await canActivate(
      context(state, { membership: { ...MEMBERSHIP, validTo: '2026-09-01T00:00:00-05:00' } }),
    );
    await readDecision(state, 'membership.expired');
  });

  it('audits a membership that is not valid yet -> membership.not_yet_valid', async () => {
    const state = createFakeClient();
    await canActivate(
      context(state, { membership: { ...MEMBERSHIP, validFrom: '2027-01-01T00:00:00-05:00' } }),
    );
    await readDecision(state, 'membership.not_yet_valid');
  });

  it('audits caja of sede A reading sede B -> scope.outside_subtree', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { entityOrgNodeId: 'org-sede-b' }));
    await readDecision(state, 'scope.outside_subtree');
  });

  it('audits trabajador of obra A marking obra B -> scope.outside_subtree', async () => {
    const state = createFakeClient();
    await canActivate(
      context(state, {
        identity: { ...IDENTITY, roles: ['trabajador'] },
        membership: { ...MEMBERSHIP, role: 'trabajador', orgNodeId: 'org-obra-a' },
        scopeSubtree: ['org-obra-a'],
        entityOrgNodeId: 'org-obra-b',
      }),
    );
    await readDecision(state, 'scope.outside_subtree');
  });

  it('audits jefe_obra of obra A opening obra B -> scope.outside_subtree', async () => {
    const state = createFakeClient();
    await canActivate(
      context(state, {
        identity: { ...IDENTITY, roles: ['jefe_obra'] },
        membership: { ...MEMBERSHIP, role: 'jefe_obra', orgNodeId: 'org-obra-a' },
        scopeSubtree: ['org-empresa', 'org-obra-a'],
        entityOrgNodeId: 'org-obra-b',
      }),
    );
    await readDecision(state, 'scope.outside_subtree');
  });

  it('audits editing a voided invoice -> state.denied', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { stateAllows: false }));
    await readDecision(state, 'state.denied');
  });

  it('audits a tenant without the salud module -> module.inactive', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { moduleActive: false }));
    await readDecision(state, 'module.inactive');
  });

  it('audits a caller without membership -> membership.inactive', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { membership: null }));
    await readDecision(state, 'membership.inactive');
  });

  it('writes exactly one access.denied row per denial', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { rolePermits: false }));

    assert.equal(state.queries.length, 1);
    const [query] = state.queries;
    assert.match(query.text, /INSERT INTO audit_log/);
    assert.match(query.text, /access\.denied|VALUES/);
    assert.ok(query.text.includes('diff'));
  });

  it('records action, actor, tenant and the trace id on the denial row', async () => {
    const state = createFakeClient();
    await canActivate(
      context(
        state,
        { rolePermits: false },
        { traceId: 'trace-777', entity: 'clinical_history', entityId: 'entity-1' },
      ),
    );

    const row = state.queries[0];
    assert.ok(row.values !== undefined);
    const [tenantId, actor, action, entity, entityId, , diff] = row.values as [
      string, string, string, string, string, unknown, string,
    ];
    assert.equal(tenantId, TENANT_ID);
    assert.equal(actor, USER_ID);
    assert.equal(action, ACCESS_DENIED_ACTION);
    assert.equal(entity, 'clinical_history');
    assert.equal(entityId, 'entity-1');

    const parsed = JSON.parse(diff) as Record<string, unknown>;
    assert.equal(parsed.traceId, 'trace-777');
    assert.equal(parsed.reason, 'role.denied');
    assert.equal(parsed.attemptedAction, 'patient_file.open');
    assert.equal(parsed.role, 'caja');
    assert.deepEqual(parsed.roles, ['caja']);
    assert.equal(parsed.at, NOW);
  });

  it('falls back to the token tenant when there is no membership row', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { membership: null }));

    const row = state.queries[0];
    assert.equal((row.values as readonly unknown[])[0], TENANT_ID);
  });

  it('propagates an audit failure instead of returning a silent denial', async () => {
    const state = createFakeClient();
    state.fail();
    await assert.rejects(
      canActivate(context(state, { rolePermits: false })),
      /audit insert failed/,
    );
  });
});

/** Asserts the recorded row and returns the decision for one denial. */
async function readDecision(
  state: FakeClientState,
  expectedReason: string,
): Promise<{ allow: boolean; reason: string }> {
  assert.equal(state.queries.length, 1, `expected one audit row for ${expectedReason}`);
  const diff = JSON.parse((state.queries[0].values as readonly unknown[])[6] as string) as {
    reason: string;
    traceId: string;
  };
  assert.equal(diff.reason, expectedReason);
  assert.equal(diff.traceId, 'trace-42');
  return { allow: false, reason: diff.reason };
}

describe('loadMembership', () => {
  it('maps a raw membership row to the rule input shape', async () => {
    const state = createFakeClient({
      rows: [
        {
          id: 'mem-1',
          user_id: USER_ID,
          tenant_id: TENANT_ID,
          org_node_id: 'org-sede-a',
          role: 'caja',
          scopes: ['crm-core', 'salud'],
          active: true,
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          valid_to: new Date('2026-12-31T00:00:00.000Z'),
        },
      ],
    });

    const membership = await loadMembership(state.client, USER_ID, TENANT_ID);
    assert.deepEqual(membership, {
      id: 'mem-1',
      userId: USER_ID,
      tenantId: TENANT_ID,
      orgNodeId: 'org-sede-a',
      role: 'caja',
      scopes: ['crm-core', 'salud'],
      active: true,
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-12-31T00:00:00.000Z',
    });
  });

  it('scopes the query by user and tenant', async () => {
    const state = createFakeClient({ rows: [] });
    await loadMembership(state.client, USER_ID, TENANT_ID);

    assert.match(state.queries[0].text, /FROM memberships/);
    assert.deepEqual(state.queries[0].values, [USER_ID, TENANT_ID]);
  });

  it('returns null when the caller has no membership', async () => {
    const state = createFakeClient({ rows: [] });
    assert.equal(await loadMembership(state.client, USER_ID, TENANT_ID), null);
  });

  it('returns null when the client answers without rows', async () => {
    const state = createFakeClient({});
    assert.equal(await loadMembership(state.client, USER_ID, TENANT_ID), null);
  });
});

describe('mapMembershipRow', () => {
  it('keeps a null valid_to as an open-ended membership', () => {
    const mapped = mapMembershipRow({
      id: 'mem-2',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      org_node_id: 'org-sede-a',
      role: 'medico',
      scopes: [],
      active: false,
      valid_from: '2026-02-01T00:00:00.000Z',
      valid_to: null,
    });
    assert.equal(mapped.active, false);
    assert.equal(mapped.validTo, null);
  });
});

// ---------------------------------------------------------------------------
// Denial audit org node and the membership-less salud list reads (MVP1 W2F).
//
// `audit_log.org_node_id` is a FK to `org_nodes` and the tenant id is not a
// node id. Before the fix a caller without a membership — every salud list
// read — reached the denial insert with the tenant id as the scope-term
// placeholder (the list endpoints have no single target row), Postgres raised
// SQLSTATE 23503, the failure propagated fail-closed and the typed 403 became
// an untyped 500. These cases pin both halves of the fix: the guard never
// records a non-node value, and the list reads answer with the typed envelope.
// They live in this spec file because `npm test` enumerates the spec files by
// path, so a new spec file would never be executed.
// ---------------------------------------------------------------------------

/** The one recorded `access.denied` insert, or a failed assertion. */
function auditInsert(state: FakeClientState): RecordedQuery {
  const query = state.queries.find((entry) => entry.text.includes('INSERT INTO audit_log'));
  assert.ok(query, 'expected an audit_log insert');
  return query;
}

/** The recorded `org_node_id` bind parameter of the denial row. */
function auditedOrgNodeId(state: FakeClientState): unknown {
  return (auditInsert(state).values as readonly unknown[])[5];
}

describe('denial audit org node (W2F)', () => {
  it('records a null org node for a membership-less caller', async () => {
    const state = createFakeClient();
    await canActivate(
      context(
        state,
        { membership: null, scopeSubtree: [], entityOrgNodeId: TENANT_ID },
        { orgNodeId: TENANT_ID, attemptedAction: 'patient.list' },
      ),
    );

    const diff = JSON.parse((auditInsert(state).values as readonly unknown[])[6] as string) as {
      reason: string;
    };
    assert.equal(diff.reason, 'membership.inactive');
    assert.equal(auditedOrgNodeId(state), null, 'the tenant id is not an org node');
  });

  it('never records the tenant id as an org node', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { rolePermits: false, entityOrgNodeId: TENANT_ID }));
    assert.equal(auditedOrgNodeId(state), null);
  });

  it('keeps a real target org node on the denial row', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { rolePermits: false, entityOrgNodeId: 'org-sede-b' }));
    assert.equal(auditedOrgNodeId(state), 'org-sede-b');
  });

  it('resolves the recorded org node through org_nodes so an unknown id cannot abort the denial', async () => {
    const state = createFakeClient();
    await canActivate(context(state, { rolePermits: false }));
    assert.match(auditInsert(state).text, /\(SELECT id FROM org_nodes WHERE id = \$6\)/);
  });
});

/** Node ids the fake database knows; any other non-NULL value violates the FK. */
const KNOWN_ORG_NODE_IDS = new Set(['org-sede-a']);

interface SaludFakeState {
  readonly client: {
    query(text: string, values?: readonly unknown[]): Promise<unknown>;
  };
  readonly queries: RecordedQuery[];
}

/**
 * Request client double for a salud list read: no membership row, `salud`
 * module active, and the `audit_log.org_node_id` FK modelled after Postgres —
 * a non-NULL org node outside {@link KNOWN_ORG_NODE_IDS} rejects with SQLSTATE
 * 23503, the exact failure W2F removes.
 */
function createSaludClient(): SaludFakeState {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(text: string, values?: readonly unknown[]): Promise<unknown> {
      queries.push({ text, values });
      if (text.includes('FROM memberships')) return { rows: [] };
      if (text.includes('FROM tenants')) return { rows: [{ modules: ['salud'] }] };
      if (text.includes('INSERT INTO audit_log')) {
        const orgNodeId = values?.[5];
        if (
          orgNodeId !== null &&
          orgNodeId !== undefined &&
          !KNOWN_ORG_NODE_IDS.has(String(orgNodeId))
        ) {
          throw Object.assign(
            new Error(
              'insert or update on table "audit_log" violates foreign key constraint "audit_log_org_node_id_fkey"',
            ),
            { code: '23503', constraint: 'audit_log_org_node_id_fkey' },
          );
        }
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

/** The three read paths listed in the W2F ticket, all membership-less here. */
const MEMBERSHIP_LESS_LIST_READS = [
  ['patients', listPatients],
  ['episodes', listEpisodes],
  ['appointments', listAppointments],
] as const;

describe('membership-less salud list reads (W2F)', () => {
  it('answers the typed 403 envelope instead of the untyped audit FK 500', async () => {
    for (const [name, list] of MEMBERSHIP_LESS_LIST_READS) {
      const state = createSaludClient();

      await assert.rejects(
        list({
          client: state.client,
          tenantId: TENANT_ID,
          userId: USER_ID,
          roles: [],
          traceId: 'trace-9',
          ip: null,
        }),
        (error: unknown) => {
          assert.ok(error instanceof HttpException, `${name}: expected the typed HttpException`);
          assert.equal(error.getStatus(), 403, `${name}: status`);
          const body = error.getResponse() as { code: string; reason: string; traceId: string };
          assert.equal(body.code, 'access.denied', `${name}: code`);
          assert.equal(body.reason, 'membership.inactive', `${name}: reason`);
          assert.equal(body.traceId, 'trace-9', `${name}: traceId`);
          return true;
        },
      );

      const audit = state.queries.find((entry) => entry.text.includes('INSERT INTO audit_log'));
      assert.ok(audit, `${name}: the denial is still audited`);
      assert.equal((audit.values as readonly unknown[])[5], null, `${name}: org node`);
      assert.equal((audit.values as readonly unknown[])[0], TENANT_ID, `${name}: tenant`);
    }
  });
});
