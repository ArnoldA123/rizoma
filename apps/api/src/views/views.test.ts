// Saved-view coverage (B1): closed entity list, exact-equality filters,
// tenant+owner scope (own vs shared vs foreign), owner-only mutations and the
// `?saved_view_id=` resolve/conditions helpers.
//
// The SQL client is a small stateful in-memory double: it implements the exact
// statements `views/views.service.ts` issues over synthetic rows, so the suite
// exercises the real control flow (guard, scope, audit) without Postgres. All
// data is synthetic.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  buildSavedViewConditions,
  createSavedView,
  getSavedView,
  listSavedViews,
  parseViewCreateInput,
  parseViewsQuery,
  removeSavedView,
  resolveSavedViewForList,
  updateSavedView,
  type SavedViewRecord,
  type ViewsActor,
  type ViewsClient,
} from './views.service.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const OWNER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_ID = 'b1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ORG_NODE_ID = 'c1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const VIEW_ID = 'd1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PATIENT_ID = 'e1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ID_OWN_PRIVATE = '11111111-1111-1111-1111-111111111111';
const ID_OWN_SHARED = '22222222-2222-2222-2222-222222222222';
const ID_OTHER_SHARED = '33333333-3333-3333-3333-333333333333';
const ID_OTHER_PRIVATE = '44444444-4444-4444-4444-444444444444';
const ID_LEGACY = '55555555-5555-5555-5555-555555555555';
const ID_INACTIVE = '66666666-6666-6666-6666-666666666666';
const ID_FOREIGN_TENANT = '77777777-7777-7777-7777-777777777777';
const ID_SECRET = '88888888-8888-8888-8888-888888888888';
const ID_WRONG = '99999999-9999-9999-9999-999999999999';
const ID_OFF = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_P1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ID_I1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TRACE = 'trace-views-1';

// ============ in-memory double ============

interface FakeRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  entity: string;
  filters: Record<string, string | number | boolean>;
  shared: boolean;
  active: boolean;
}

interface FakeDb {
  /** Membership answered to the guard lookup (`null` = no membership). */
  membershipUserId: string | null;
  views: FakeRow[];
  auditActions: string[];
  nextId: number;
}

function newDb(): FakeDb {
  return { membershipUserId: OWNER_ID, views: [], auditActions: [], nextId: 1 };
}

function membershipRow(userId: string): Record<string, unknown> {
  return {
    id: 'f1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    user_id: userId,
    tenant_id: TENANT_ID,
    org_node_id: ORG_NODE_ID,
    role: 'recepcion',
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

function toDbRow(row: FakeRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    entity: row.entity,
    filters: { ...row.filters },
    shared: row.shared,
    active: row.active,
  };
}

function visibleTo(views: FakeRow[], tenantId: string, userId: string): FakeRow[] {
  return views.filter(
    (row) =>
      row.tenant_id === tenantId &&
      (row.user_id === userId || row.shared || row.user_id === null),
  );
}

function makeClient(db: FakeDb): ViewsClient {
  return {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.includes('FROM memberships')) {
        const userId = values[0];
        const rows =
          db.membershipUserId !== null && userId === db.membershipUserId
            ? [membershipRow(db.membershipUserId)]
            : [];
        return { rows };
      }
      if (text.startsWith('INSERT INTO audit_log')) {
        db.auditActions.push(String(values[2]));
        return { rows: [] };
      }
      if (text.startsWith('INSERT INTO saved_views')) {
        const [tenantId, userId, entity, filtersJson, shared] = values as [
          string,
          string,
          string,
          string,
          boolean,
        ];
        const row: FakeRow = {
          id: `view-${db.nextId++}`,
          tenant_id: tenantId,
          user_id: userId,
          entity,
          filters: JSON.parse(filtersJson) as Record<string, string | number | boolean>,
          shared,
          active: true,
        };
        db.views.push(row);
        return { rows: [toDbRow(row)] };
      }
      if (text.startsWith('UPDATE saved_views\nSET active = FALSE')) {
        const [id, tenantId, userId] = values as [string, string, string];
        const row = db.views.find(
          (candidate) =>
            candidate.id === id && candidate.tenant_id === tenantId && candidate.user_id === userId,
        );
        if (row === undefined) return { rows: [] };
        row.active = false;
        return { rows: [toDbRow(row)] };
      }
      if (text.startsWith('UPDATE saved_views')) {
        const [id, tenantId, userId, entity, filtersJson, shared, active] = values as [
          string,
          string,
          string,
          string | null,
          string | null,
          boolean | null,
          boolean | null,
        ];
        const row = db.views.find(
          (candidate) =>
            candidate.id === id && candidate.tenant_id === tenantId && candidate.user_id === userId,
        );
        if (row === undefined) return { rows: [] };
        if (entity !== null) row.entity = entity;
        if (filtersJson !== null) {
          row.filters = JSON.parse(filtersJson) as Record<string, string | number | boolean>;
        }
        if (shared !== null) row.shared = shared;
        if (active !== null) row.active = active;
        return { rows: [toDbRow(row)] };
      }
      if (text.includes('FROM saved_views')) {
        const tenantId = values[0] as string;
        // Single-row reads carry the id in $2.
        if (text.includes('AND id = $2')) {
          const [ , id, userId ] = values as [string, string, string];
          const onlyActive = text.includes('active = TRUE');
          const row = db.views.find(
            (candidate) =>
              candidate.tenant_id === tenantId &&
              candidate.id === id &&
              (!onlyActive || candidate.active) &&
              (candidate.user_id === userId || candidate.shared || candidate.user_id === null),
          );
          return { rows: row === undefined ? [] : [toDbRow(row)] };
        }
        // List reads: active only, optional `entity = $3`.
        const userId = values[1] as string;
        let rows = visibleTo(db.views, tenantId, userId).filter((row) => row.active);
        if (text.includes('entity = $3')) {
          const entity = values[2] as string;
          rows = rows.filter((row) => row.entity === entity);
        }
        return { rows: rows.map(toDbRow) };
      }
      throw new Error(`Unexpected statement: ${text.slice(0, 80)}`);
    },
  };
}

function actor(db: FakeDb, userId: string): ViewsActor {
  return { client: makeClient(db), tenantId: TENANT_ID, userId, traceId: TRACE, ip: null };
}

function seedView(
  db: FakeDb,
  overrides: Partial<FakeRow> & { id: string },
): void {
  db.views.push({
    tenant_id: TENANT_ID,
    user_id: OWNER_ID,
    entity: 'patients',
    filters: {},
    shared: false,
    active: true,
    ...overrides,
  });
}

function statusOf(error: unknown): number {
  assert.ok(error instanceof HttpException);
  return error.getStatus();
}

// ============ input validation ============

describe('parseViewCreateInput', () => {
  it('rejects an entity outside the closed list', () => {
    assert.throws(() => parseViewCreateInput({ entity: 'episodes', filters: {} }, TRACE));
  });

  it('rejects unknown keys, operators and non-scalar values', () => {
    assert.throws(() =>
      parseViewCreateInput({ entity: 'patients', filters: { status: 'x' } }, TRACE),
    );
    assert.throws(() =>
      parseViewCreateInput({ entity: 'invoices', filters: { status: { eq: 'paid' } } }, TRACE),
    );
    assert.throws(() =>
      parseViewCreateInput({ entity: 'invoices', filters: { status: ['paid'] } }, TRACE),
    );
  });
});

describe('parseViewsQuery', () => {
  it('rejects an unknown entity instead of silently listing everything', () => {
    assert.throws(() => parseViewsQuery({ entity: 'episodes' }, TRACE));
  });
});

// ============ scope ============

describe('listSavedViews scope', () => {
  it('returns own plus shared views, never foreign private ones', async () => {
    const db = newDb();
    seedView(db, { id: ID_OWN_PRIVATE, user_id: OWNER_ID, shared: false });
    seedView(db, { id: ID_OWN_SHARED, user_id: OWNER_ID, shared: true });
    seedView(db, { id: ID_OTHER_SHARED, user_id: OTHER_ID, shared: true });
    seedView(db, { id: ID_OTHER_PRIVATE, user_id: OTHER_ID, shared: false });
    seedView(db, { id: ID_LEGACY, user_id: null, shared: false });
    seedView(db, { id: ID_INACTIVE, user_id: OWNER_ID, shared: false, active: false });
    seedView(db, {
      id: ID_FOREIGN_TENANT,
      tenant_id: 'f1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      user_id: OWNER_ID,
      shared: true,
    });

    const rows = await listSavedViews(actor(db, OWNER_ID), {});
    const ids = rows.map((row) => row.id).sort();
    assert.deepEqual(ids, [ID_OWN_PRIVATE, ID_OWN_SHARED, ID_OTHER_SHARED, ID_LEGACY]);
  });

  it('narrows by entity when asked', async () => {
    const db = newDb();
    seedView(db, { id: ID_P1, entity: 'patients' });
    seedView(db, { id: ID_I1, entity: 'invoices' });
    const rows = await listSavedViews(actor(db, OWNER_ID), { entity: 'invoices' });
    assert.deepEqual(rows.map((row) => row.id), [ID_I1]);
  });

  it('denies callers without a membership in the tenant', async () => {
    const db = newDb();
    db.membershipUserId = null;
    const error = await listSavedViews(actor(db, OTHER_ID), {}).catch((e: unknown) => e);
    assert.equal(statusOf(error), 403);
  });
});

// ============ mutations ============

describe('saved view mutations', () => {
  it('creates an owned view and audits the write', async () => {
    const db = newDb();
    const record = await createSavedView(actor(db, OWNER_ID), {
      entity: 'patients',
      filters: { active: true, documentType: 'DNI' },
      shared: false,
    });
    assert.equal(record.tenantId, TENANT_ID);
    assert.equal(record.userId, OWNER_ID);
    assert.deepEqual(record.filters, { active: true, documentType: 'DNI' });
    assert.deepEqual(db.auditActions, ['saved_view.created']);
  });

  it('reads one visible view; foreign private views are 404', async () => {
    const db = newDb();
    seedView(db, { id: VIEW_ID, shared: true, user_id: OTHER_ID });
    seedView(db, { id: ID_SECRET, shared: false, user_id: OTHER_ID });

    const shared = await getSavedView(actor(db, OWNER_ID), VIEW_ID);
    assert.equal(shared.id, VIEW_ID);

    const missing = await getSavedView(actor(db, OWNER_ID), ID_SECRET).catch((e: unknown) => e);
    assert.equal(statusOf(missing), 404);
    const malformed = await getSavedView(actor(db, OWNER_ID), 'nope').catch((e: unknown) => e);
    assert.equal(statusOf(malformed), 400);
  });

  it('lets only the owner update; shared foreign views are 403', async () => {
    const db = newDb();
    seedView(db, { id: VIEW_ID, entity: 'patients', filters: {}, shared: false });
    seedView(db, { id: ID_OTHER_SHARED, entity: 'patients', filters: {}, shared: true, user_id: OTHER_ID });

    const updated = await updateSavedView(actor(db, OWNER_ID), VIEW_ID, { shared: true });
    assert.equal(updated.shared, true);
    assert.deepEqual(db.auditActions, ['saved_view.updated']);

    const foreign = await updateSavedView(actor(db, OWNER_ID), ID_OTHER_SHARED, { shared: false }).catch(
      (e: unknown) => e,
    );
    assert.equal(statusOf(foreign), 403);

    const empty = await updateSavedView(actor(db, OWNER_ID), VIEW_ID, {}).catch((e: unknown) => e);
    assert.equal(statusOf(empty), 400);
  });

  it('re-validates filters against the retargeted entity on PATCH', async () => {
    const db = newDb();
    seedView(db, { id: VIEW_ID, entity: 'patients', filters: { active: true } });
    const error = await updateSavedView(actor(db, OWNER_ID), VIEW_ID, {
      entity: 'invoices',
      filters: { active: true },
    }).catch((e: unknown) => e);
    assert.equal(statusOf(error), 400);
  });

  it('soft-deletes on remove; the row leaves the list but stays readable', async () => {
    const db = newDb();
    seedView(db, { id: VIEW_ID, shared: false });
    const removed = await removeSavedView(actor(db, OWNER_ID), VIEW_ID);
    assert.equal(removed.active, false);
    assert.deepEqual(db.auditActions, ['saved_view.removed']);

    const rows: SavedViewRecord[] = await listSavedViews(actor(db, OWNER_ID), {});
    assert.deepEqual(rows.map((row) => row.id), []);
    const stillThere = await getSavedView(actor(db, OWNER_ID), VIEW_ID);
    assert.equal(stillThere.active, false);
  });
});

// ============ `?saved_view_id=` helpers ============

describe('resolveSavedViewForList', () => {
  it('resolves a visible active view of the expected entity', async () => {
    const db = newDb();
    seedView(db, {
      id: VIEW_ID,
      entity: 'invoices',
      filters: { status: 'paid' },
      shared: true,
      user_id: OTHER_ID,
    });
    const resolved = await resolveSavedViewForList(actor(db, OWNER_ID), VIEW_ID, 'invoices');
    assert.deepEqual(resolved.filters, { status: 'paid' });
  });

  it('rejects entity mismatches, inactive and invisible views', async () => {
    const db = newDb();
    seedView(db, { id: ID_WRONG, entity: 'patients', filters: {} });
    seedView(db, { id: ID_OFF, entity: 'invoices', filters: {}, active: false });
    seedView(db, { id: ID_SECRET, entity: 'invoices', filters: {}, shared: false, user_id: OTHER_ID });

    const mismatch = await resolveSavedViewForList(actor(db, OWNER_ID), ID_WRONG, 'invoices').catch(
      (e: unknown) => e,
    );
    assert.equal(statusOf(mismatch), 400);
    const inactive = await resolveSavedViewForList(actor(db, OWNER_ID), ID_OFF, 'invoices').catch(
      (e: unknown) => e,
    );
    assert.equal(statusOf(inactive), 404);
    const invisible = await resolveSavedViewForList(actor(db, OWNER_ID), ID_SECRET, 'invoices').catch(
      (e: unknown) => e,
    );
    assert.equal(statusOf(invisible), 404);
  });
});

describe('buildSavedViewConditions', () => {
  it('builds parameterized equalities continuing the listing placeholders', () => {
    const conditions = buildSavedViewConditions(
      'appointments',
      { status: 'scheduled', patientId: PATIENT_ID },
      3,
      TRACE,
    );
    assert.deepEqual(conditions.clauses, ['"status" = $3', '"patient_id" = $4']);
    assert.deepEqual(conditions.values, ['scheduled', PATIENT_ID]);
  });

  it('rejects unknown keys and mistyped uuid/boolean values', () => {
    assert.throws(() => buildSavedViewConditions('patients', { status: 'x' }, 3, TRACE));
    assert.throws(() =>
      buildSavedViewConditions('appointments', { patientId: 'nope' }, 3, TRACE),
    );
    assert.throws(() => buildSavedViewConditions('patients', { active: 'yes' }, 3, TRACE));
  });
});
