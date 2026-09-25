// Keyset pagination coverage for the billing invoice listing
// (`listInvoices` in `billing.service.ts`).
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), one `saved_views` row and the invoice
// listing query over synthetic rows, applying the same scope, direct and
// view filters, keyset predicate, `(created_at DESC, id DESC)` order and
// `LIMIT` semantics as the real SQL. The suite walks a 3-row page with
// `limit 2` through the chained `nextCursor`, proves `saved_view_id` ANDs
// with the cursor, and pins the 400 on a malformed cursor plus the 500→200
// clamp. All data is synthetic and every amount is PEN.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_ERROR,
  listInvoices,
  type ActorContext,
  type BillingPage,
  type InvoiceRecord,
  type SaludClient,
} from './billing.service.ts';

const TENANT = 'a5000000-0000-4000-8000-0000000000f1';
const SEDE = 'b5000000-0000-4000-8000-0000000000f1';
const USER = 'c5000000-0000-4000-8000-0000000000f1';
const MEMBERSHIP = 'd5000000-0000-4000-8000-0000000000f1';
const VIEW_ID = 'e5000000-0000-4000-8000-0000000000f1';
const I1 = 'f5000000-0000-4000-8000-000000000001';
const I2 = 'f5000000-0000-4000-8000-000000000002';
const I3 = 'f5000000-0000-4000-8000-000000000003';
const TRACE = 'trace-billing-pagination';

type Row = Record<string, unknown>;

function invoiceRow(id: string, createdAt: string, status: string): Row {
  return {
    id,
    tenant_id: TENANT,
    org_node_id: SEDE,
    quote_id: null,
    serie: 'F001',
    numero: Number(id.slice(-4)),
    customer_doc_type: 'dni',
    customer_doc_number: '99990001',
    customer_name: 'PACIENTE DEMO UNO',
    items: [{ description: 'Consulta ambulatoria', quantity: 1, unitPrice: 100 }],
    subtotal: 100,
    igv_rate: 0.18,
    igv_total: 18,
    total: 118,
    status,
    fiscal_status: 'pending',
    fiscal_adapter: 'manual_v1',
    fiscal_payload: {},
    cash_session_id: null,
    issued_at: createdAt,
    created_at: createdAt,
  };
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: string[];
}

function createDb(): FakeDb {
  const queries: string[] = [];
  const invoices: Row[] = [
    invoiceRow(I1, '2026-03-10T09:00:00.000Z', 'issued'),
    invoiceRow(I2, '2026-03-09T09:00:00.000Z', 'issued'),
    invoiceRow(I3, '2026-03-08T09:00:00.000Z', 'voided'),
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
              role: 'caja',
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
              entity: 'invoices',
              filters: { status: 'issued' },
              shared: false,
              active: true,
            },
          ],
        };
      }
      if (text.includes('FROM invoices WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = values[1] as string[];
        let rows = invoices.filter((invoice) => scope.includes(String(invoice.org_node_id)));
        for (const [column, value] of equalityFilters(text, values)) {
          if (column === 'status') rows = rows.filter((row) => String(row.status) === String(value));
          if (column === 'serie') rows = rows.filter((row) => String(row.serie) === String(value));
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
          (left, right) => String(right.created_at).localeCompare(String(left.created_at)),
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

/** Narrows the list union onto the paged envelope (limit requests must page). */
function asPage(value: InvoiceRecord[] | BillingPage<InvoiceRecord>): BillingPage<InvoiceRecord> {
  assert.ok(!Array.isArray(value), 'a limit request must answer the paged envelope');
  return value;
}

/** Decodes cleanly but carries no ordering key, so the listing must 400. */
function cursorWithoutOrderingKey(): string {
  return Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString('base64url');
}

describe('listInvoices keyset walk', () => {
  it('chains limit 2 over 3 rows without overlap or gaps', async () => {
    const db = createDb();
    const first = asPage(await listInvoices(actor(db), { limit: '2' }));
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [I1, I2],
    );
    assert.ok(first.nextCursor !== null, 'a partial page must offer the next cursor');

    const second = asPage(await listInvoices(actor(db), { limit: '2', cursor: first.nextCursor }));
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [I3],
    );
    assert.equal(second.nextCursor, null);
  });

  it('combines saved_view_id with the cursor inside the filtered walk', async () => {
    const db = createDb();
    const first = asPage(await listInvoices(actor(db), { limit: '1', saved_view_id: VIEW_ID }));
    assert.deepEqual(
      first.rows.map((row) => row.id),
      [I1],
    );
    assert.ok(first.nextCursor !== null);

    const second = asPage(
      await listInvoices(actor(db), {
        limit: '1',
        saved_view_id: VIEW_ID,
        cursor: first.nextCursor,
      }),
    );
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [I2],
    );
    assert.equal(second.nextCursor, null);
    for (const page of [first, second]) {
      for (const row of page.rows) assert.equal(row.status, 'issued');
    }
  });

  it('rejects a malformed cursor with a 400 billing.invalid_param', async () => {
    const db = createDb();
    try {
      await listInvoices(actor(db), { cursor: cursorWithoutOrderingKey() });
    } catch (error) {
      const http = httpError(error);
      assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
      assert.equal(http?.status, 400);
      assert.equal(http?.body.code, BILLING_ERROR.invalidParam);
      return;
    }
    throw new Error('expected the call to fail with billing.invalid_param');
  });

  it('clamps limit 500 to 200 instead of applying it', async () => {
    const db = createDb();
    const page = asPage(await listInvoices(actor(db), { limit: '500' }));
    assert.equal(page.rows.length, 3);
    assert.equal(page.nextCursor, null);
    assert.ok(
      db.queries.some((text) => text.includes('LIMIT 201')),
      `expected a clamped LIMIT 201, saw: ${db.queries.join(' | ')}`,
    );
  });
});
