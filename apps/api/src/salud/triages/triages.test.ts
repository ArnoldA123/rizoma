// Triage service coverage (bases-consolidadas-v1.md §2.3): insert-only vital
// signs with the `patient.write` guard, the sede scope and one audit row per
// write.
//
// The SQL client is an in-memory double keyed by statement fragment, like
// `consents.test.ts`, so the suite asserts the persisted row and the
// `audit_log` rows without a database. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTriage, listTriages } from '../triages.service.ts';
import type { ActorContext, SaludClient } from '../salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c1000000-0000-4000-8000-0000000000a1';
const USER_ENFERMERIA = 'c1000000-0000-4000-8000-0000000000a2';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e1000000-0000-4000-8000-0000000000a1';
const EPISODE_ID = 'f1000000-0000-4000-8000-0000000000a1';
const OTHER_EPISODE = 'f1000000-0000-4000-8000-0000000000b2';
const TRIAGE_ID = 'aa000000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-triage-1';

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: role === 'enfermeria' ? USER_ENFERMERIA : USER_MEDICO,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    role,
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

// ============ in-memory query double ============

interface Route {
  readonly match: string;
  readonly rows: readonly Record<string, unknown>[];
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: RecordedQuery[];
}

function createDb(...routes: readonly Route[]): FakeDb {
  const queries: RecordedQuery[] = [];
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      const route = routes.find((candidate) => text.includes(candidate.match));
      return { rows: route?.rows ?? [] };
    },
  };
  return { client, queries };
}

/** Every `audit_log` insert, with its action and decoded `diff`. */
function audits(db: FakeDb): { action: string; diff: Record<string, unknown> }[] {
  return db.queries
    .filter((query) => query.text.includes('INSERT INTO audit_log'))
    .map((query) => ({
      action: String(query.values[2]),
      diff: JSON.parse(String(query.values[6])) as Record<string, unknown>,
    }));
}

function actor(client: SaludClient, overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    client,
    tenantId: TENANT_ID,
    userId: USER_MEDICO,
    roles: [],
    traceId: TRACE,
    ip: null,
    ...overrides,
  };
}

/** Base routes every allowed use case needs (guard facts + patient scope). */
function baseRoutes(
  role = 'medico',
  patientRows: readonly Record<string, unknown>[] = [
    { id: PATIENT_ID, tenant_id: TENANT_ID, org_node_id: SEDE_A, active: true },
  ],
): Route[] {
  return [
    { match: 'FROM memberships', rows: [membershipRow(role)] },
    { match: 'WITH RECURSIVE subtree', rows: [{ id: SEDE_A }] },
    { match: 'FROM tenants', rows: [{ modules: ['crm-core', 'salud'] }] },
    { match: 'FROM patient_files', rows: patientRows },
  ];
}

function triageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TRIAGE_ID,
    tenant_id: TENANT_ID,
    patient_id: PATIENT_ID,
    episode_id: null,
    recorded_by: USER_MEDICO,
    values: { systolic: 120, diastolic: 80 },
    at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

/** Extracts `{status, body}` from a thrown Nest `HttpException`. */
function httpError(error: unknown): { status: number; body: Record<string, unknown> } | null {
  const candidate = error as { getStatus?: () => number; getResponse?: () => unknown };
  if (typeof candidate.getStatus !== 'function' || typeof candidate.getResponse !== 'function') {
    return null;
  }
  const response = candidate.getResponse() as unknown;
  const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
  return { status: candidate.getStatus(), body };
}

function isError(code: string, status = 400): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    const http = httpError(error);
    return http !== null && http.status === status && http.body.code === code;
  };
}

const CREATE_BODY = {
  patientId: PATIENT_ID,
  values: { systolic: 120, diastolic: 80, heartRate: 72 },
};

describe('listTriages', () => {
  it('returns the history most recent first, capped at 200 rows', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'FROM triages',
      rows: [triageRow(), triageRow({ id: 'bb000000-0000-4000-8000-0000000000b1' })],
    });
    const rows = await listTriages(actor(db.client), PATIENT_ID);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.patientId, PATIENT_ID);
    assert.equal(rows[0]?.recordedBy, USER_MEDICO);
    assert.deepEqual(rows[0]?.values, { systolic: 120, diastolic: 80 });
    const select = db.queries.find((query) => query.text.includes('FROM triages'));
    assert.ok(select?.text.includes('LIMIT 200'), 'the history read stays capped');
    assert.ok(select?.text.includes('ORDER BY at DESC'), 'most recent first');
  });

  it('rejects an unknown patient with 404 not_found', async () => {
    const db = createDb(...baseRoutes('medico', []));
    await assert.rejects(
      async () => listTriages(actor(db.client), PATIENT_ID),
      isError('not_found', 404),
    );
  });

  it('denies a role without patient.read and audits the denial', async () => {
    const db = createDb(...baseRoutes('caja'));
    await assert.rejects(
      async () => listTriages(actor(db.client), PATIENT_ID),
      isError('access.denied', 403),
    );
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.diff.reason, 'role.denied');
  });
});

describe('createTriage', () => {
  it('records the row with the caller as recorder and audits the write', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'INSERT INTO triages',
      rows: [triageRow()],
    });
    const created = await createTriage(actor(db.client), CREATE_BODY);

    assert.equal(created.patientId, PATIENT_ID);
    assert.equal(created.recordedBy, USER_MEDICO);
    assert.deepEqual(created.values, { systolic: 120, diastolic: 80 });

    const insert = db.queries.find((query) => query.text.includes('INSERT INTO triages'));
    assert.equal(insert?.values[3], USER_MEDICO, 'recorded_by is the caller');
    assert.deepEqual(
      JSON.parse(String(insert?.values[4])) as unknown,
      CREATE_BODY.values,
      'values travel as a JSON bag',
    );
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'triage.created');
    assert.equal(trail[0]?.diff.traceId, TRACE);
  });

  it('accepts an episode of the same patient and a supplied instant', async () => {
    const db = createDb(
      ...baseRoutes(),
      { match: 'FROM episodes', rows: [{ id: EPISODE_ID, patient_id: PATIENT_ID }] },
      { match: 'INSERT INTO triages', rows: [triageRow({ episode_id: EPISODE_ID })] },
    );
    const created = await createTriage(actor(db.client), {
      ...CREATE_BODY,
      episodeId: EPISODE_ID,
      at: '2026-09-25T10:00:00.000Z',
    });

    assert.equal(created.episodeId, EPISODE_ID);
    const insert = db.queries.find((query) => query.text.includes('INSERT INTO triages'));
    assert.equal(insert?.values[2], EPISODE_ID);
    assert.equal(insert?.values[5], '2026-09-25T10:00:00.000Z');
  });

  it('refuses an episode of another patient before the guard runs', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'FROM episodes',
      rows: [{ id: OTHER_EPISODE, patient_id: 'e1000000-0000-4000-8000-0000000000ff' }],
    });
    await assert.rejects(
      async () => createTriage(actor(db.client), { ...CREATE_BODY, episodeId: OTHER_EPISODE }),
      isError('validation.failed', 400),
    );
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO triages')),
      false,
    );
  });

  it('refuses an empty values bag', async () => {
    const db = createDb(...baseRoutes());
    await assert.rejects(
      async () => createTriage(actor(db.client), { patientId: PATIENT_ID, values: {} }),
      isError('validation.failed', 400),
    );
  });

  it('refuses an unparseable instant', async () => {
    const db = createDb(...baseRoutes());
    await assert.rejects(
      async () => createTriage(actor(db.client), { ...CREATE_BODY, at: 'ayer a las diez' }),
      isError('validation.failed', 400),
    );
  });

  it('denies a read-only role with role.denied and audits the denial', async () => {
    const db = createDb(...baseRoutes('enfermeria'));
    await assert.rejects(
      async () => createTriage(actor(db.client, { userId: USER_ENFERMERIA }), CREATE_BODY),
      isError('access.denied', 403),
    );
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.diff.reason, 'role.denied');
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO triages')),
      false,
      'a denied write stores nothing',
    );
  });

  it('denies a write on an inactive file with state.denied', async () => {
    const db = createDb(
      ...baseRoutes('medico', [
        { id: PATIENT_ID, tenant_id: TENANT_ID, org_node_id: SEDE_A, active: false },
      ]),
    );
    await assert.rejects(
      async () => createTriage(actor(db.client), CREATE_BODY),
      isError('access.denied', 403),
    );
    assert.equal(audits(db)[0]?.diff.reason, 'state.denied');
  });
});
