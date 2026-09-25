// Prescription service coverage (bases-consolidadas-v1.md §2.3): the
// template-based order with the `episode.write` guard, the episode-derived
// patient and one audit row per write.
//
// The SQL client is an in-memory double keyed by statement fragment, like
// `consents.test.ts`, so the suite asserts the persisted row and the
// `audit_log` rows without a database. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPrescription, listPrescriptions } from '../prescriptions.service.ts';
import type { ActorContext, SaludClient } from '../salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c1000000-0000-4000-8000-0000000000a1';
const USER_ENFERMERIA = 'c1000000-0000-4000-8000-0000000000a2';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e1000000-0000-4000-8000-0000000000a1';
const EPISODE_ID = 'f1000000-0000-4000-8000-0000000000a1';
const PRESCRIPTION_ID = 'aa000000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-prescription-1';

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

/** Guard facts every use case needs (membership, subtree, module). */
function guardRoutes(role = 'medico'): Route[] {
  return [
    { match: 'FROM memberships', rows: [membershipRow(role)] },
    { match: 'WITH RECURSIVE subtree', rows: [{ id: SEDE_A }] },
    { match: 'FROM tenants', rows: [{ modules: ['crm-core', 'salud'] }] },
  ];
}

function episodeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EPISODE_ID,
    patient_id: PATIENT_ID,
    status: 'open',
    org_node_id: SEDE_A,
    ...overrides,
  };
}

function prescriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRESCRIPTION_ID,
    tenant_id: TENANT_ID,
    patient_id: PATIENT_ID,
    episode_id: EPISODE_ID,
    template_code: 'receta.general',
    items: [{ description: 'Amoxicilina 500 mg', quantity: 21 }],
    status: 'draft',
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
  episodeId: EPISODE_ID,
  templateCode: 'receta.general',
  items: [{ description: 'Amoxicilina 500 mg', quantity: 21 }],
};

describe('listPrescriptions', () => {
  it('lists the orders of one patient, capped at 200 rows', async () => {
    const db = createDb(
      ...guardRoutes(),
      {
        match: 'FROM patient_files',
        rows: [{ id: PATIENT_ID, tenant_id: TENANT_ID, org_node_id: SEDE_A }],
      },
      { match: 'FROM prescriptions', rows: [prescriptionRow()] },
    );
    const rows = await listPrescriptions(actor(db.client), { patientId: PATIENT_ID });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.patientId, PATIENT_ID);
    assert.equal(rows[0]?.status, 'draft');
    assert.deepEqual(rows[0]?.items, [{ description: 'Amoxicilina 500 mg', quantity: 21 }]);
    const select = db.queries.find((query) => query.text.includes('FROM prescriptions'));
    assert.ok(select?.text.includes('LIMIT 200'), 'the history read stays capped');
  });

  it('lists the orders of one episode through the patient sede', async () => {
    const db = createDb(
      ...guardRoutes(),
      { match: 'JOIN patient_files', rows: [episodeRow()] },
      { match: 'FROM prescriptions', rows: [prescriptionRow()] },
    );
    const rows = await listPrescriptions(actor(db.client), { episodeId: EPISODE_ID });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.episodeId, EPISODE_ID);
  });

  it('refuses a read without any filter', async () => {
    const db = createDb(...guardRoutes());
    await assert.rejects(
      async () => listPrescriptions(actor(db.client), {}),
      isError('validation.failed', 400),
    );
  });

  it('rejects an unknown episode with 404 not_found', async () => {
    const db = createDb(...guardRoutes());
    await assert.rejects(
      async () => listPrescriptions(actor(db.client), { episodeId: EPISODE_ID }),
      isError('not_found', 404),
    );
  });
});

describe('createPrescription', () => {
  it('creates a draft order with the patient derived from the episode', async () => {
    const db = createDb(
      ...guardRoutes(),
      { match: 'JOIN patient_files', rows: [episodeRow()] },
      { match: 'INSERT INTO prescriptions', rows: [prescriptionRow()] },
    );
    const created = await createPrescription(actor(db.client), CREATE_BODY);

    assert.equal(created.episodeId, EPISODE_ID);
    assert.equal(created.patientId, PATIENT_ID, 'the patient comes from the episode');
    assert.equal(created.status, 'draft', 'an omitted status means draft');
    assert.equal(created.templateCode, 'receta.general');

    const insert = db.queries.find((query) => query.text.includes('INSERT INTO prescriptions'));
    assert.equal(insert?.values[1], PATIENT_ID, 'patient_id is the episode patient');
    assert.equal(insert?.values[2], EPISODE_ID);
    assert.equal(insert?.values[5], 'draft');
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'prescription.created');
    assert.equal(trail[0]?.diff.items, 1);
  });

  it('honours an explicit issued status of the catalog', async () => {
    const db = createDb(
      ...guardRoutes(),
      { match: 'JOIN patient_files', rows: [episodeRow()] },
      { match: 'INSERT INTO prescriptions', rows: [prescriptionRow({ status: 'issued' })] },
    );
    const created = await createPrescription(actor(db.client), {
      ...CREATE_BODY,
      status: 'issued',
    });
    assert.equal(created.status, 'issued');
  });

  it('refuses an empty order and a status outside the catalog', async () => {
    const db = createDb(
      ...guardRoutes(),
      { match: 'JOIN patient_files', rows: [episodeRow()] },
    );
    await assert.rejects(
      async () => createPrescription(actor(db.client), { ...CREATE_BODY, items: [] }),
      isError('validation.failed', 400),
    );
    await assert.rejects(
      async () => createPrescription(actor(db.client), { ...CREATE_BODY, status: 'pending' }),
      isError('validation.failed', 400),
    );
    await assert.rejects(
      async () => createPrescription(actor(db.client), { ...CREATE_BODY, templateCode: '' }),
      isError('validation.failed', 400),
    );
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO prescriptions')),
      false,
    );
  });

  it('refuses a line without a description', async () => {
    const db = createDb(
      ...guardRoutes(),
      { match: 'JOIN patient_files', rows: [episodeRow()] },
    );
    await assert.rejects(
      async () => createPrescription(actor(db.client), { ...CREATE_BODY, items: [{ quantity: 2 }] }),
      isError('validation.failed', 400),
    );
  });

  it('denies a role without episode.write and audits the denial', async () => {
    const db = createDb(
      ...guardRoutes('enfermeria'),
      { match: 'JOIN patient_files', rows: [episodeRow()] },
    );
    await assert.rejects(
      async () => createPrescription(actor(db.client, { userId: USER_ENFERMERIA }), CREATE_BODY),
      isError('access.denied', 403),
    );
    assert.equal(audits(db)[0]?.diff.reason, 'role.denied');
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO prescriptions')),
      false,
      'a denied write stores nothing',
    );
  });

  it('denies prescribing into a closed episode with state.denied', async () => {
    const db = createDb(
      ...guardRoutes(),
      { match: 'JOIN patient_files', rows: [episodeRow({ status: 'closed' })] },
    );
    await assert.rejects(
      async () => createPrescription(actor(db.client), CREATE_BODY),
      isError('access.denied', 403),
    );
    assert.equal(audits(db)[0]?.diff.reason, 'state.denied');
  });

  it('rejects an unknown episode with 404 not_found', async () => {
    const db = createDb(...guardRoutes());
    await assert.rejects(
      async () => createPrescription(actor(db.client), CREATE_BODY),
      isError('not_found', 404),
    );
  });
});
