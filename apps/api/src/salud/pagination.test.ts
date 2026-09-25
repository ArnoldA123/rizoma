// Keyset pagination coverage for the salud listings
// (`listPatientsPage`, `listAppointmentsPage` in `salud.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), one `saved_views` row and the two
// listing queries over synthetic rows, applying the same scope, view-filter,
// keyset-predicate, ordering and `LIMIT` semantics as the real SQL. The suite
// walks a 3-row page with `limit 2` through the chained `nextCursor`, proves
// `saved_view_id` ANDs with the cursor, and pins the 400 on a malformed
// cursor plus the 500→200 clamp. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listAppointmentsPage,
  listPatientsPage,
  type ActorContext,
  type SaludClient,
} from './salud.service.ts';

const TENANT = 'a4000000-0000-4000-8000-0000000000a1';
const SEDE = 'b4000000-0000-4000-8000-000000000001';
const USER = 'c4000000-0000-4000-8000-000000000001';
const MEMBERSHIP = 'd4000000-0000-4000-8000-000000000001';
const VIEW_ID = 'e4000000-0000-4000-8000-000000000001';
const P1 = 'f4000000-0000-4000-8000-000000000001';
const P2 = 'f4000000-0000-4000-8000-000000000002';
const P3 = 'f4000000-0000-4000-8000-000000000003';
const AP1 = 'f4000000-0000-4000-8000-000000000011';
const AP2 = 'f4000000-0000-4000-8000-000000000012';
const AP3 = 'f4000000-0000-4000-8000-000000000013';
const TRACE = 'trace-salud-pagination';

type Row = Record<string, unknown>;

function patientRow(id: string, createdAt: string, documentType: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: SEDE,
    person_name: `Patient ${id.slice(-4)}`,
    document_type: documentType,
    document_number: `900000${id.slice(-2)}`,
    birthdate: '1990-01-01',
    allergies: [],
    alerts: [],
    contacts: {},
    active: true,
    created_at: createdAt,
  };
}

function appointmentRow(id: string, startsAt: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: SEDE,
    patient_id: P1,
    professional_id: USER,
    starts_at: startsAt,
    duration_min: 30,
    status: 'scheduled',
    created_at: startsAt,
  };
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const patients: Row[] = [
    patientRow(P1, '2026-03-03T10:00:00.000Z', 'dni'),
    patientRow(P2, '2026-03-02T10:00:00.000Z', 'dni'),
    patientRow(P3, '2026-03-01T10:00:00.000Z', 'ce'),
  ];
  const appointments: Row[] = [
    appointmentRow(AP1, '2026-04-03T10:00:00.000Z'),
    appointmentRow(AP2, '2026-04-02T10:00:00.000Z'),
    appointmentRow(AP3, '2026-04-01T10:00:00.000Z'),
  ];

  /** Reads the `"col" = $n` view predicates back out of the listing SQL. */
  function equalityFilters(text: string, values: readonly unknown[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const match of text.matchAll(/"([a-z_]+)"\s*=\s*\$(\d+)/g)) {
      out.set(match[1], values[Number(match[2]) - 1]);
    }
    return out;
  }

  function limitOf(text: string): number {
    const match = text.match(/LIMIT (\d+)\s*$/);
    return match === null ? 200 : Number(match[1]);
  }

  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push(text);
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: MEMBERSHIP,
              user_id: USER,
              tenant_id: TENANT,
              org_node_id: SEDE,
              role: 'medico',
              scopes: [],
              active: true,
              valid_from: '2020-01-01T00:00:00.000Z',
              valid_to: null,
              user_active: true,
            },
          ],
        };
      }
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE }] };
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'salud'] }] };
      }
      if (text.includes('FROM saved_views')) {
        if (String(values[1]) !== VIEW_ID) return { rows: [] };
        return {
          rows: [
            {
              id: VIEW_ID,
              tenant_id: TENANT,
              user_id: USER,
              entity: 'patients',
              filters: { documentType: 'dni' },
              shared: false,
              active: true,
            },
          ],
        };
      }
      if (text.includes('FROM patient_files WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = values[1] as string[];
        const filters = equalityFilters(text, values);
        let rows = patients.filter((row) => scope.includes(String(row.org_node_id)));
        const documentType = filters.get('document_type');
        if (documentType !== undefined) {
          rows = rows.filter((row) => String(row.document_type) === String(documentType));
        }
        if (text.includes('(created_at < $')) {
          const cursorCreatedAt = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.created_at) < cursorCreatedAt ||
              (String(row.created_at) === cursorCreatedAt && String(row.id) < cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) ||
            String(right.id).localeCompare(String(left.id)),
        );
        return { rows: rows.slice(0, limitOf(text)) };
      }
      if (text.includes('FROM appointments WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = values[1] as string[];
        let rows = appointments.filter((row) => scope.includes(String(row.org_node_id)));
        if (text.includes('(starts_at < $')) {
          const cursorStartsAt = String(values[values.length - 2]);
          const cursorId = String(values[values.length - 1]);
          rows = rows.filter(
            (row) =>
              String(row.starts_at) < cursorStartsAt ||
              (String(row.starts_at) === cursorStartsAt && String(row.id) < cursorId),
          );
        }
        rows = [...rows].sort(
          (left, right) =>
            String(right.starts_at).localeCompare(String(left.starts_at)) ||
            String(right.id).localeCompare(String(left.id)),
        );
        return { rows: rows.slice(0, limitOf(text)) };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(db: FakeDb): ActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: USER,
    roles: [],
    traceId: TRACE,
    ip: null,
  };
}

function httpStatus(error: unknown): number | null {
  const candidate = error as { getStatus?: () => number };
  return typeof candidate.getStatus === 'function' ? candidate.getStatus() : null;
}

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listPatientsPage keyset walk', () => {
  it('chains limit 2 over 3 rows without overlap or gaps', async () => {
    const db = createDb();
    const first = await listPatientsPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [P1, P2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second = await listPatientsPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [P3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('combines saved_view_id with the cursor inside the filtered walk', async () => {
    const db = createDb();
    const first = await listPatientsPage(actor(db), { limit: '1', savedViewId: VIEW_ID });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [P1],
    );
    assert.ok(first.nextCursor !== null);

    const second = await listPatientsPage(actor(db), {
      limit: '1',
      savedViewId: VIEW_ID,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [P2],
    );
    assert.equal(second.nextCursor, null);
    for (const page of [first, second]) {
      for (const row of page.rows) assert.equal(row.documentType, 'dni');
    }
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    await assert.rejects(
      listPatientsPage(actor(db), { cursor: cursorWithoutOrderingKey() }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = await listPatientsPage(actor(db), { limit: '500' });
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});

describe('listAppointmentsPage keyset walk', () => {
  it('chains limit 2 over 3 rows through the opaque cursor', async () => {
    const db = createDb();
    const first = await listAppointmentsPage(actor(db), { limit: '2' });
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [AP1, AP2],
    );
    assert.ok(first.nextCursor !== null);

    const second = await listAppointmentsPage(actor(db), { limit: '2', cursor: first.nextCursor });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [AP3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('rejects a malformed cursor with a 400', async () => {
    const db = createDb();
    await assert.rejects(
      listAppointmentsPage(actor(db), { cursor: cursorWithoutOrderingKey() }),
      (error: unknown) => {
        assert.equal(httpStatus(error), 400);
        return true;
      },
    );
  });
});
