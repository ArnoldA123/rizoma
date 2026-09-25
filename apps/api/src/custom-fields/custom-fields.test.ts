// Custom-field service coverage (B2): tenant-admin CRUD over
// `custom_field_defs` plus write-time enforcement (`required` + `type`) over
// the `contacts`/`values` JSONB bags.
//
// The SQL client is an in-memory double keyed by statement fragment, like
// `salud/triages/triages.test.ts`, so the suite asserts the persisted rows and
// the `audit_log` rows without a database. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCustomField,
  getCustomField,
  listCustomFields,
  loadActiveDefs,
  parseCustomFieldCreateInput,
  parseCustomFieldUpdateInput,
  updateCustomField,
  validateCustomValues,
  type CustomFieldActor,
  type CustomFieldClient,
  type CustomFieldDef,
} from './custom-fields.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const USER_ADMIN = 'c1000000-0000-4000-8000-0000000000a1';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000a1';
const DEF_ID = 'e1000000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-custom-1';

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: USER_ADMIN,
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

function defRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEF_ID,
    tenant_id: TENANT_ID,
    module: 'salud',
    entity: 'patient',
    code: 'healthInsurance',
    type: 'text',
    required: false,
    status: 'draft',
    ...overrides,
  };
}

// ============ in-memory query double ============

interface Route {
  readonly match: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly error?: { code: string };
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  readonly client: CustomFieldClient;
  readonly queries: RecordedQuery[];
}

function createDb(...routes: readonly Route[]): FakeDb {
  const queries: RecordedQuery[] = [];
  const client: CustomFieldClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      const route = routes.find((candidate) => text.includes(candidate.match));
      if (route?.error !== undefined) {
        const failure = new Error('duplicate key value') as Error & { code: string };
        failure.code = route.error.code;
        throw failure;
      }
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

function actor(client: CustomFieldClient): CustomFieldActor {
  return { client, tenantId: TENANT_ID, userId: USER_ADMIN, traceId: TRACE, ip: null };
}

/** Guard facts every management use case needs (admin membership + subtree). */
function adminRoutes(role = 'ti_admin'): Route[] {
  return [
    { match: 'FROM memberships', rows: [membershipRow(role)] },
    { match: 'WITH RECURSIVE subtree', rows: [{ id: SEDE_A }] },
  ];
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

describe('parseCustomFieldCreateInput', () => {
  it('accepts the documented shape with defaults for required and status', () => {
    const parsed = parseCustomFieldCreateInput(
      { module: 'salud', entity: 'patient', code: 'healthInsurance', type: 'text' },
      TRACE,
    );
    assert.equal(parsed.required, false);
    assert.equal(parsed.status, 'draft');
  });

  it('refuses an unknown type, a bad code and a non-boolean required', () => {
    const base = { module: 'salud', entity: 'patient', code: 'ok_code', type: 'text' };
    assert.throws(() => parseCustomFieldCreateInput({ ...base, type: 'relation' }, TRACE), isError('validation.failed'));
    assert.throws(() => parseCustomFieldCreateInput({ ...base, code: '9lives' }, TRACE), isError('validation.failed'));
    assert.throws(() => parseCustomFieldCreateInput({ ...base, required: 'yes' }, TRACE), isError('validation.failed'));
    assert.throws(() => parseCustomFieldCreateInput({ ...base, status: 'archived' }, TRACE), isError('validation.failed'));
  });

  it('refuses an empty update body', () => {
    assert.throws(() => parseCustomFieldUpdateInput({}, TRACE), isError('validation.failed'));
    const parsed = parseCustomFieldUpdateInput({ required: true, status: 'active' }, TRACE);
    assert.equal(parsed.required, true);
    assert.equal(parsed.status, 'active');
  });
});

describe('createCustomField', () => {
  it('inserts the row as draft and audits the write', async () => {
    const db = createDb(...adminRoutes(), {
      match: 'INSERT INTO custom_field_defs',
      rows: [defRow()],
    });
    const created = await createCustomField(actor(db.client), {
      module: 'salud',
      entity: 'patient',
      code: 'healthInsurance',
      type: 'text',
    });

    assert.equal(created.code, 'healthInsurance');
    assert.equal(created.status, 'draft');
    const insert = db.queries.find((query) => query.text.includes('INSERT INTO custom_field_defs'));
    assert.deepEqual(insert?.values.slice(1, 5), ['salud', 'patient', 'healthInsurance', 'text']);
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'custom_field.created');
    assert.equal(trail[0]?.diff.traceId, TRACE);
  });

  it('maps a duplicate key onto 409 duplicate', async () => {
    const db = createDb(...adminRoutes(), {
      match: 'INSERT INTO custom_field_defs',
      rows: [],
      error: { code: '23505' },
    });
    await assert.rejects(
      async () =>
        createCustomField(actor(db.client), {
          module: 'salud',
          entity: 'patient',
          code: 'healthInsurance',
          type: 'text',
        }),
      isError('duplicate', 409),
    );
    assert.equal(audits(db).length, 0);
  });

  it('denies a non-admin role with role.denied and audits the denial', async () => {
    const db = createDb(...adminRoutes('medico'));
    await assert.rejects(
      async () =>
        createCustomField(actor(db.client), {
          module: 'salud',
          entity: 'patient',
          code: 'healthInsurance',
          type: 'text',
        }),
      isError('access.denied', 403),
    );
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.diff.reason, 'role.denied');
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO custom_field_defs')),
      false,
      'a denied write stores nothing',
    );
  });
});

describe('listCustomFields', () => {
  it('returns the tenant definitions ordered by code', async () => {
    const db = createDb(...adminRoutes(), {
      match: 'FROM custom_field_defs',
      rows: [defRow(), defRow({ id: 'e1000000-0000-4000-8000-0000000000b2', code: 'bloodType' })],
    });
    const rows = await listCustomFields(actor(db.client), {});
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.code, 'healthInsurance');
  });

  it('narrows by module+entity and refuses an unknown status', async () => {
    const db = createDb(...adminRoutes(), {
      match: 'FROM custom_field_defs',
      rows: [defRow({ status: 'active' })],
    });
    const rows = await listCustomFields(actor(db.client), { module: 'salud', entity: 'patient' });
    assert.equal(rows.length, 1);
    const select = db.queries.find((query) => query.text.includes('FROM custom_field_defs'));
    assert.deepEqual(select?.values, [TENANT_ID, 'salud', 'patient']);
    await assert.rejects(
      async () => listCustomFields(actor(db.client), { status: 'archived' }),
      isError('validation.failed'),
    );
  });
});

describe('getCustomField / updateCustomField', () => {
  it('opens one definition and answers 404 when absent', async () => {
    const db = createDb(...adminRoutes(), {
      match: 'FROM custom_field_defs',
      rows: [defRow({ status: 'active' })],
    });
    const found = await getCustomField(actor(db.client), DEF_ID);
    assert.equal(found.status, 'active');

    const missing = createDb(...adminRoutes());
    await assert.rejects(
      async () => getCustomField(actor(missing.client), DEF_ID),
      isError('not_found', 404),
    );
  });

  it('retires a definition and audits the write', async () => {
    const db = createDb(...adminRoutes(), {
      match: 'UPDATE custom_field_defs',
      rows: [defRow({ status: 'retired' })],
    });
    const updated = await updateCustomField(actor(db.client), DEF_ID, { status: 'retired' });
    assert.equal(updated.status, 'retired');
    const update = db.queries.find((query) => query.text.includes('UPDATE custom_field_defs'));
    assert.deepEqual(update?.values.slice(2), [null, null, 'retired']);
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'custom_field.updated');
  });

  it('answers 404 for an unknown id without auditing', async () => {
    const db = createDb(...adminRoutes());
    await assert.rejects(
      async () => updateCustomField(actor(db.client), DEF_ID, { status: 'active' }),
      isError('not_found', 404),
    );
    assert.equal(audits(db).length, 0);
  });
});

describe('validateCustomValues', () => {
  const defs: CustomFieldDef[] = [
    {
      id: DEF_ID,
      tenantId: TENANT_ID,
      module: 'salud',
      entity: 'patient',
      code: 'healthInsurance',
      type: 'text',
      required: true,
      status: 'active',
    },
    {
      id: 'e1000000-0000-4000-8000-0000000000b2',
      tenantId: TENANT_ID,
      module: 'salud',
      entity: 'patient',
      code: 'dependents',
      type: 'number',
      required: false,
      status: 'active',
    },
    {
      id: 'e1000000-0000-4000-8000-0000000000b3',
      tenantId: TENANT_ID,
      module: 'salud',
      entity: 'patient',
      code: 'lastCheckup',
      type: 'date',
      required: false,
      status: 'active',
    },
    {
      id: 'e1000000-0000-4000-8000-0000000000b4',
      tenantId: TENANT_ID,
      module: 'salud',
      entity: 'patient',
      code: 'organDonor',
      type: 'boolean',
      required: false,
      status: 'active',
    },
  ];

  it('accepts a fully typed bag and ignores unknown keys', () => {
    validateCustomValues(
      defs,
      {
        phone: '+51000000001',
        healthInsurance: 'EsSalud',
        dependents: 2,
        lastCheckup: '2026-03-04',
        organDonor: true,
      },
      TRACE,
    );
  });

  it('accepts an absent optional field but refuses a missing required one', () => {
    validateCustomValues(defs, { healthInsurance: 'SIS' }, TRACE);
    assert.throws(() => validateCustomValues(defs, { phone: 'x' }, TRACE), isError('validation.failed'));
    assert.throws(
      () => validateCustomValues(defs, { healthInsurance: '   ' }, TRACE),
      isError('validation.failed'),
    );
  });

  it('refuses a mistyped value per type', () => {
    const base = { healthInsurance: 'EsSalud' };
    assert.throws(
      () => validateCustomValues(defs, { ...base, dependents: 'two' }, TRACE),
      isError('validation.failed'),
    );
    assert.throws(
      () => validateCustomValues(defs, { ...base, lastCheckup: '04/03/2026' }, TRACE),
      isError('validation.failed'),
    );
    assert.throws(
      () => validateCustomValues(defs, { ...base, lastCheckup: '2026-02-30' }, TRACE),
      isError('validation.failed'),
    );
    assert.throws(
      () => validateCustomValues(defs, { ...base, organDonor: 'yes' }, TRACE),
      isError('validation.failed'),
    );
    assert.throws(
      () => validateCustomValues(defs, { ...base, healthInsurance: 42 }, TRACE),
      isError('validation.failed'),
    );
  });
});

describe('loadActiveDefs', () => {
  it('reads only the active definitions of the pair', async () => {
    const db = createDb({
      match: 'FROM custom_field_defs',
      rows: [defRow({ status: 'active' })],
    });
    const defs = await loadActiveDefs(db.client, TENANT_ID, 'salud', 'patient');
    assert.equal(defs.length, 1);
    assert.equal(defs[0]?.status, 'active');
    const select = db.queries.find((query) => query.text.includes('FROM custom_field_defs'));
    assert.ok(select?.text.includes("status = 'active'"), 'draft/retired rows never shape a write');
    assert.deepEqual(select?.values, [TENANT_ID, 'salud', 'patient']);
  });
});
