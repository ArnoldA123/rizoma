// Billing service coverage for the Peru cashier + manual invoicing flow
// (bases-consolidadas-v1.md §2.5; peru-anexo-v1.md §3): IGV per line, gapless
// folio reservation, `Idempotency-Key` replay/conflict, the `pending → issued →
// paid / partially_paid / voided` commercial states and the open-shift gate.
//
// The SQL client is a small stateful in-memory double: it implements the exact
// statements `billing.service.ts` issues over a set of synthetic tables, so the
// suite exercises the real control flow (guard, counters, idempotency table)
// without Postgres. All data is synthetic and every amount is PEN.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_ERROR,
  closeCashSession,
  computeInvoiceTotals,
  computeLineIgv,
  createQuote,
  getInvoiceWithFiscal,
  issueInvoice,
  listInvoices,
  listQuotes,
  openCashSession,
  payInvoice,
  round2,
  voidInvoice,
} from './billing.service.ts';
import type { ActorContext, SaludClient } from './billing.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000f1';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000f1';
const SEDE_B = 'b1000000-0000-4000-8000-0000000000f2';
const USER_CAJA = 'c1000000-0000-4000-8000-0000000000f1';
const USER_MEDICO = 'c1000000-0000-4000-8000-0000000000f2';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000f1';
const SESSION_ID = 'e1000000-0000-4000-8000-0000000000f1';
const TRACE = 'trace-billing-1';

const DNIS = {
  consulta: { customerDocType: 'dni', customerDocNumber: '99990001', customerName: 'PACIENTE DEMO UNO' },
  otro: { customerDocType: 'dni', customerDocNumber: '99990002', customerName: 'PACIENTE DEMO DOS' },
};

function issueBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orgNodeId: SEDE_A,
    serie: 'F001',
    ...DNIS.consulta,
    items: [{ description: 'Consulta ambulatoria', quantity: 1, unitPrice: 100 }],
    ...overrides,
  };
}

// ============ in-memory double ============

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface IdempotencyEntry {
  requestHash: string;
  response: unknown;
  valid: boolean;
}

interface FakeState {
  role: string;
  orgNodeId: string;
  subtree: string[];
  modules: string[];
  cashSessions: Map<string, Record<string, unknown>>;
  quotes: Map<string, Record<string, unknown>>;
  counters: Map<string, number>;
  idempotency: Map<string, IdempotencyEntry>;
  invoices: Map<string, Record<string, unknown>>;
  payments: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  sequence: number;
}

interface FakeDb {
  readonly client: SaludClient;
  readonly state: FakeState;
  readonly queries: RecordedQuery[];
}

function nextId(state: FakeState): string {
  state.sequence += 1;
  return `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
}

function seedInvoice(state: FakeState, overrides: Record<string, unknown> = {}): string {
  const id = nextId(state);
  state.invoices.set(id, {
    id,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    quote_id: null,
    serie: 'F001',
    numero: state.invoices.size + 1,
    customer_doc_type: 'dni',
    customer_doc_number: '99990001',
    customer_name: 'PACIENTE DEMO UNO',
    items: [{ description: 'Consulta ambulatoria', quantity: 1, unitPrice: 100 }],
    subtotal: 100,
    igv_rate: 0.18,
    igv_total: 18,
    total: 118,
    status: 'issued',
    fiscal_status: 'pending',
    fiscal_adapter: 'manual_v1',
    fiscal_payload: {},
    cash_session_id: SESSION_ID,
    issued_at: '2026-03-10T09:00:00.000Z',
    created_at: '2026-03-10T09:00:00.000Z',
    ...overrides,
    id,
  });
  return id;
}

function seedSession(state: FakeState, orgNodeId = SEDE_A, id = SESSION_ID): string {
  state.cashSessions.set(id, {
    id,
    tenant_id: TENANT_ID,
    org_node_id: orgNodeId,
    opened_by: USER_CAJA,
    opened_at: '2026-01-01T08:00:00.000Z',
    closed_at: null,
    totals: {},
    status: 'open',
  });
  return id;
}

function newState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    role: 'caja',
    orgNodeId: SEDE_A,
    subtree: [SEDE_A],
    modules: ['crm-core', 'salud'],
    cashSessions: new Map(),
    quotes: new Map(),
    counters: new Map(),
    idempotency: new Map(),
    invoices: new Map(),
    payments: [],
    audits: [],
    sequence: 0,
    ...overrides,
  };
}

function membershipRow(state: FakeState): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: state.role === 'medico' ? USER_MEDICO : USER_CAJA,
    tenant_id: TENANT_ID,
    org_node_id: state.orgNodeId,
    role: state.role,
    scopes: [],
    active: true,
    valid_from: '2020-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

function sumRegistered(state: FakeState, invoiceId: string): number {
  let total = 0;
  for (const payment of state.payments) {
    if (payment.invoice_id === invoiceId && payment.status === 'registered') {
      total += Number(payment.amount);
    }
  }
  return total;
}

/**
 * Stateful double: one branch per statement fragment the service issues. The
 * branch order matters where fragments share a prefix (`UPDATE invoices ...`).
 */
function createDb(state: FakeState): FakeDb {
  const queries: RecordedQuery[] = [];

  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push({ text, values });
      const v = values;

      if (text.includes('FROM memberships')) {
        return { rows: state.role === 'none' ? [] : [membershipRow(state)] };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: state.subtree.map((id) => ({ id })) };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: state.modules }] };
      }

      // ---- cash sessions ----
      if (text.includes('INSERT INTO cash_sessions')) {
        const id = nextId(state);
        const row = {
          id,
          tenant_id: v[0],
          org_node_id: v[1],
          opened_by: v[2],
          opened_at: '2026-01-01T09:00:00.000Z',
          closed_at: null,
          totals: {},
          status: 'open',
        };
        state.cashSessions.set(id, row);
        return { rows: [row] };
      }
      if (text.includes("org_node_id = $2 AND status = 'open'")) {
        for (const session of state.cashSessions.values()) {
          if (session.org_node_id === v[1] && session.status === 'open') return { rows: [session] };
        }
        return { rows: [] };
      }
      if (text.includes('FROM cash_sessions WHERE tenant_id = $1 AND id = $2')) {
        const session = state.cashSessions.get(String(v[1]));
        return { rows: session === undefined ? [] : [session] };
      }
      if (text.includes('UPDATE cash_sessions')) {
        const session = state.cashSessions.get(String(v[1]));
        if (session === undefined || session.status !== 'open') return { rows: [] };
        session.status = 'closed';
        session.closed_at = '2026-01-01T18:00:00.000Z';
        session.totals = JSON.parse(String(v[2])) as Record<string, unknown>;
        return { rows: [session] };
      }

      // ---- quotes ----
      if (text.includes('INSERT INTO quotes')) {
        const id = nextId(state);
        const row = {
          id,
          tenant_id: v[0],
          org_node_id: v[1],
          customer_name: v[2],
          items: JSON.parse(String(v[3])),
          total: v[4],
          status: 'draft',
          created_at: '2026-01-01T09:00:00.000Z',
        };
        state.quotes.set(id, row);
        return { rows: [row] };
      }
      if (text.includes('FROM quotes WHERE tenant_id = $1 AND org_node_id = ANY')) {
        const scope = v[1] as string[];
        const rows = [...state.quotes.values()].filter((q) => scope.includes(String(q.org_node_id)));
        return { rows };
      }

      // ---- folio counters ----
      if (text.includes('INSERT INTO invoice_counters')) {
        const key = `${String(v[0])}|${String(v[1])}`;
        if (!state.counters.has(key)) state.counters.set(key, 0);
        return { rows: [] };
      }
      if (text.includes('FROM invoice_counters WHERE tenant_id = $1 AND serie = $2 FOR UPDATE')) {
        const key = `${String(v[0])}|${String(v[1])}`;
        return { rows: [{ last_number: state.counters.get(key) ?? 0 }] };
      }
      if (text.includes('UPDATE invoice_counters')) {
        const key = `${String(v[0])}|${String(v[1])}`;
        const next = (state.counters.get(key) ?? 0) + 1;
        state.counters.set(key, next);
        return { rows: [{ last_number: next }] };
      }

      // ---- idempotency ----
      if (text.includes('INSERT INTO idempotency_keys')) {
        const key = String(v[1]);
        if (state.idempotency.has(key)) return { rows: [] };
        state.idempotency.set(key, { requestHash: String(v[2]), response: null, valid: true });
        return { rows: [{ key }] };
      }
      if (text.includes('FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 FOR UPDATE')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry === undefined) return { rows: [] };
        return {
          rows: [{ request_hash: entry.requestHash, response: entry.response, still_valid: entry.valid }],
        };
      }
      if (text.includes('SET request_hash = $3')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry !== undefined) {
          entry.requestHash = String(v[2]);
          entry.response = null;
          entry.valid = true;
        }
        return { rows: [] };
      }
      if (text.includes('SET response = $3::jsonb')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry !== undefined) entry.response = JSON.parse(String(v[2]));
        return { rows: [] };
      }
      if (text.includes('DELETE FROM idempotency_keys')) {
        state.idempotency.delete(String(v[1]));
        return { rows: [] };
      }

      // ---- invoices ----
      if (text.includes('INSERT INTO invoices')) {
        const id = nextId(state);
        const row = {
          id,
          tenant_id: v[0],
          org_node_id: v[1],
          quote_id: v[2],
          serie: v[3],
          numero: v[4],
          customer_doc_type: v[5],
          customer_doc_number: v[6],
          customer_name: v[7],
          items: JSON.parse(String(v[8])),
          subtotal: v[9],
          igv_rate: v[10],
          igv_total: v[11],
          total: v[12],
          status: 'draft',
          fiscal_status: 'pending',
          fiscal_adapter: v[13],
          fiscal_payload: {},
          cash_session_id: v[14],
          issued_at: null,
          created_at: '2026-01-01T09:00:00.000Z',
        };
        state.invoices.set(id, row);
        return { rows: [row] };
      }
      if (text.includes("SET status = 'issued'")) {
        const invoice = state.invoices.get(String(v[1]));
        if (invoice === undefined || invoice.status !== 'draft') return { rows: [] };
        invoice.status = 'issued';
        invoice.issued_at = '2026-01-01T09:00:00.000Z';
        return { rows: [invoice] };
      }
      if (text.includes("SET status = 'voided'")) {
        const invoice = state.invoices.get(String(v[1]));
        if (invoice === undefined) return { rows: [] };
        invoice.status = 'voided';
        return { rows: [invoice] };
      }
      if (text.includes('SET status = $3')) {
        const invoice = state.invoices.get(String(v[1]));
        if (invoice === undefined) return { rows: [] };
        invoice.status = v[2];
        return { rows: [invoice] };
      }
      if (text.includes('FROM invoices WHERE tenant_id = $1 AND id = $2')) {
        const invoice = state.invoices.get(String(v[1]));
        return { rows: invoice === undefined ? [] : [invoice] };
      }
      if (text.includes('FROM invoices WHERE tenant_id = $1 AND org_node_id = ANY')) {
        // List branch: the service appends the filters in the fixed order
        // cash session, status, from, to, so the values line up positionally.
        const scope = v[1] as string[];
        let index = 2;
        const cash = text.includes('cash_session_id = $') ? String(v[index++]) : null;
        const status = text.includes(' AND status = $') ? String(v[index++]) : null;
        const from = text.includes('COALESCE(issued_at, created_at) >= $') ? String(v[index++]) : null;
        const to = text.includes('COALESCE(issued_at, created_at) <= $') ? String(v[index++]) : null;
        const rows = [...state.invoices.values()]
          .filter((invoice) => scope.includes(String(invoice.org_node_id)))
          .filter((invoice) => cash === null || String(invoice.cash_session_id) === cash)
          .filter((invoice) => status === null || String(invoice.status) === status)
          .filter((invoice) => {
            const emitted = String(invoice.issued_at ?? invoice.created_at);
            return (from === null || emitted >= from) && (to === null || emitted <= to);
          })
          .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
        return { rows };
      }

      // ---- payments ----
      if (text.includes('SELECT COALESCE(SUM(amount), 0) AS paid')) {
        return { rows: [{ paid: sumRegistered(state, String(v[1])) }] };
      }
      if (text.includes('INSERT INTO payments')) {
        const id = nextId(state);
        const row = {
          id,
          tenant_id: v[0],
          invoice_id: v[1],
          method: v[2],
          amount: v[3],
          status: 'registered',
          external_ref: v[4],
          paid_at: '2026-01-01T10:00:00.000Z',
        };
        state.payments.push(row);
        return { rows: [row] };
      }
      if (text.includes('FROM payments WHERE tenant_id = $1 AND invoice_id = $2')) {
        const rows = state.payments.filter((p) => p.invoice_id === v[1]);
        return { rows };
      }

      // ---- audit ----
      if (text.includes('INSERT INTO audit_log')) {
        state.audits.push({
          tenantId: v[0],
          actor: v[1],
          action: v[2],
          entity: v[3],
          entityId: v[4],
          orgNodeId: v[5],
          diff: JSON.parse(String(v[6])) as Record<string, unknown>,
        });
        return { rows: [] };
      }

      return { rows: [] };
    },
  };

  return { client, state, queries };
}

function actor(db: FakeDb, overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    client: db.client,
    tenantId: TENANT_ID,
    userId: USER_CAJA,
    roles: [],
    traceId: TRACE,
    ip: null,
    ...overrides,
  };
}

function auditsOf(state: FakeState, action: string): Record<string, unknown>[] {
  return state.audits.filter((row) => row.action === action);
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

async function expectError(
  run: () => Promise<unknown>,
  code: string,
  status: number,
): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    const http = httpError(error);
    assert.notEqual(http, null, `expected an HttpException, got ${String(error)}`);
    assert.equal(http?.status, status, `expected ${status}, got ${http?.status}`);
    assert.equal(http?.body.code, code, `expected ${code}, got ${String(http?.body.code)}`);
    return http?.body ?? {};
  }
  throw new Error(`expected the call to fail with ${code}`);
}

// ============ money (peru-anexo-v1.md §3.1) ============

describe('money and IGV', () => {
  it('rounds half-up to 2 decimals', () => {
    assert.equal(round2(10.555), 10.56);
    assert.equal(round2(0.1 + 0.2), 0.3);
  });

  it('computes 18 % IGV for a 100.00 line', () => {
    assert.equal(computeLineIgv(100, 0.18), 18);
  });

  it('sums per-line rounded values instead of rounding the sum', () => {
    const totals = computeInvoiceTotals(
      [
        { description: 'A', quantity: 1, unitPrice: 10.55 },
        { description: 'B', quantity: 3, unitPrice: 0.03 },
      ],
      0.18,
    );
    assert.equal(totals.subtotal, 10.64);
    assert.equal(totals.igvTotal, 1.92);
    assert.equal(totals.total, 12.56);
    assert.equal(totals.lines[0]?.lineIgv, 1.9);
    assert.equal(totals.lines[1]?.lineIgv, 0.02);
  });

  it('honours a parametrizable rate', () => {
    const totals = computeInvoiceTotals([{ description: 'A', quantity: 1, unitPrice: 10.55 }], 0.1);
    assert.equal(totals.igvTotal, 1.06);
    assert.equal(totals.total, 11.61);
  });
});

// ============ validation ============

describe('issue validation', () => {
  it('rejects an empty items array', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(() => issueInvoice(actor(db), issueBody({ items: [] }), 'k1'), BILLING_ERROR.invalidItems, 400);
  });

  it('rejects a malformed serie', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(
      () => issueInvoice(actor(db), issueBody({ serie: 'serie inválida!' }), 'k1'),
      BILLING_ERROR.invalidSerie,
      400,
    );
  });

  it('rejects an out-of-range IGV rate', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(
      () => issueInvoice(actor(db), issueBody({ igvRate: 1.5 }), 'k1'),
      BILLING_ERROR.invalidRate,
      400,
    );
  });

  it('rejects a DNI that is not 8 digits', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(
      () => issueInvoice(actor(db), issueBody({ customerDocNumber: '123' }), 'k1'),
      BILLING_ERROR.invalidCustomer,
      400,
    );
  });

  it('rejects a line with a non-positive quantity', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(
      () => issueInvoice(actor(db), issueBody({ items: [{ quantity: 0, unitPrice: 10 }] }), 'k1'),
      BILLING_ERROR.invalidItems,
      400,
    );
  });

  it('requires the Idempotency-Key header', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(() => issueInvoice(actor(db), issueBody(), undefined), BILLING_ERROR.idempotencyKeyRequired, 400);
  });
});

// ============ folio gapless ============

describe('folio reservation', () => {
  it('issues the first invoice of a serie with numero 1 and fiscal defaults', async () => {
    const db = createDb(newState());
    const sessionId = seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');

    assert.equal(invoice.numero, 1);
    assert.equal(invoice.serie, 'F001');
    assert.equal(invoice.status, 'issued');
    assert.equal(invoice.fiscalStatus, 'pending');
    assert.equal(invoice.fiscalAdapter, 'manual_v1');
    assert.deepEqual(invoice.fiscalPayload, {});
    assert.equal(invoice.subtotal, 100);
    assert.equal(invoice.igvRate, 0.18);
    assert.equal(invoice.igvTotal, 18);
    assert.equal(invoice.total, 118);
    assert.equal(invoice.cashSessionId, sessionId);
    assert.equal(auditsOf(db.state, 'invoice.drafted').length, 1);
    assert.equal(auditsOf(db.state, 'invoice.issued').length, 1);
  });

  it('numbers consecutive issues without a gap', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const first = await issueInvoice(actor(db), issueBody(), 'k1');
    const second = await issueInvoice(actor(db), issueBody(), 'k2');
    assert.deepEqual([first.numero, second.numero], [1, 2]);
  });

  it('serializes a simulated concurrent double emission for the same serie', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const [a, b] = await Promise.all([
      issueInvoice(actor(db), issueBody(), 'k-a'),
      issueInvoice(actor(db), issueBody(), 'k-b'),
    ]);
    const numbers = [a.numero, b.numero].sort((left, right) => left - right);
    assert.deepEqual(numbers, [1, 2], 'no number repeats or is skipped');
    assert.equal(new Set([a.id, b.id]).size, 2);
    assert.equal(db.state.invoices.size, 2);
    assert.equal(db.state.counters.get(`${TENANT_ID}|F001`), 2);
  });

  it('keeps an independent counter per serie', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const first = await issueInvoice(actor(db), issueBody(), 'k1');
    const second = await issueInvoice(actor(db), issueBody({ serie: 'B001' }), 'k2');
    assert.deepEqual([first.numero, second.numero], [1, 1]);
  });
});

// ============ cash session gate ============

describe('open cash session gate', () => {
  it('blocks the emission when the sede has no open shift', async () => {
    const db = createDb(newState());
    await expectError(() => issueInvoice(actor(db), issueBody(), 'k1'), BILLING_ERROR.cashSessionClosed, 409);
    assert.equal(db.state.invoices.size, 0);
    assert.equal(db.state.counters.size, 0, 'no folio is burned');
  });

  it('frees the idempotency claim when the emission is blocked', async () => {
    const db = createDb(newState());
    await expectError(() => issueInvoice(actor(db), issueBody(), 'k1'), BILLING_ERROR.cashSessionClosed, 409);
    assert.equal(db.state.idempotency.has('k1'), false, 'the retry is not answered with a null response');
  });

  it('blocks the emission on an explicitly closed shift', async () => {
    const db = createDb(newState());
    const sessionId = seedSession(db.state);
    await closeCashSession(actor(db), { cashSessionId: sessionId });
    await expectError(
      () => issueInvoice(actor(db), issueBody({ cashSessionId: sessionId }), 'k1'),
      BILLING_ERROR.cashSessionClosed,
      409,
    );
  });

  it('rejects an unknown cashSessionId with 404', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await expectError(
      () =>
        issueInvoice(
          actor(db),
          issueBody({ cashSessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
          'k1',
        ),
      BILLING_ERROR.cashSessionNotFound,
      404,
    );
  });

  it('opens a shift and audits the write', async () => {
    const db = createDb(newState());
    const session = await openCashSession(actor(db), { orgNodeId: SEDE_A });
    assert.equal(session.status, 'open');
    assert.equal(session.orgNodeId, SEDE_A);
    const audit = auditsOf(db.state, 'cash_session.opened');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.entityId, session.id);
  });

  it('closes a shift once; a second close is state.denied', async () => {
    const db = createDb(newState());
    const sessionId = seedSession(db.state);
    const closed = await closeCashSession(actor(db), { cashSessionId: sessionId, totals: { efectivo: 118 } });
    assert.equal(closed.status, 'closed');
    assert.deepEqual(closed.totals, { efectivo: 118 });
    assert.equal(auditsOf(db.state, 'cash_session.closed').length, 1);
    await expectError(
      () => closeCashSession(actor(db), { cashSessionId: sessionId }),
      'access.denied',
      403,
    );
  });
});

// ============ idempotency ============

describe('Idempotency-Key', () => {
  it('replays the stored invoice for the same key and body', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const first = await issueInvoice(actor(db), issueBody(), 'k1');
    const replay = await issueInvoice(actor(db), issueBody(), 'k1');
    assert.equal(replay.id, first.id);
    assert.equal(replay.numero, first.numero);
    assert.equal(db.state.invoices.size, 1, 'no second invoice is written');
    assert.equal(db.state.counters.get(`${TENANT_ID}|F001`), 1, 'no second folio is burned');
  });

  it('rejects the same key with a different body as a conflict', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    await issueInvoice(actor(db), issueBody(), 'k1');
    await expectError(
      () => issueInvoice(actor(db), issueBody({ ...DNIS.otro }), 'k1'),
      BILLING_ERROR.idempotencyConflict,
      409,
    );
    assert.equal(db.state.invoices.size, 1);
  });

  it('issues independently for two different keys with the same body', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const first = await issueInvoice(actor(db), issueBody(), 'k1');
    const second = await issueInvoice(actor(db), issueBody(), 'k2');
    assert.equal(db.state.invoices.size, 2);
    assert.deepEqual([first.numero, second.numero], [1, 2]);
  });

  it('treats an expired key as new', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const first = await issueInvoice(actor(db), issueBody(), 'k1');
    const entry = db.state.idempotency.get('k1');
    assert.notEqual(entry, undefined);
    if (entry !== undefined) entry.valid = false;
    const second = await issueInvoice(actor(db), issueBody(), 'k1');
    assert.notEqual(second.id, first.id);
    assert.equal(second.numero, 2);
  });
});

// ============ payments ============

describe('payments', () => {
  it('registers a partial payment and moves to partially_paid', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    const paid = await payInvoice(actor(db), invoice.id, { method: 'efectivo', amount: 50 });
    assert.equal(paid.status, 'partially_paid');
    assert.equal(auditsOf(db.state, 'payment.registered').length, 1);
    assert.equal(auditsOf(db.state, 'invoice.paid').length, 1);
    assert.equal(paid.id, invoice.id);
  });

  it('moves to paid when the sum covers the total', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await payInvoice(actor(db), invoice.id, { method: 'efectivo', amount: 50 });
    const paid = await payInvoice(actor(db), invoice.id, { method: 'yape', amount: 68, externalRef: 'YP-1' });
    assert.equal(paid.status, 'paid');
    assert.equal(db.state.payments.length, 2);
  });

  it('rejects an overpayment', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await expectError(
      () => payInvoice(actor(db), invoice.id, { method: 'efectivo', amount: 200 }),
      BILLING_ERROR.paymentExceedsTotal,
      400,
    );
    assert.equal(db.state.payments.length, 0);
  });

  it('rejects a non-positive amount', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await expectError(
      () => payInvoice(actor(db), invoice.id, { method: 'efectivo', amount: 0 }),
      BILLING_ERROR.paymentInvalid,
      400,
    );
  });

  it('rejects a payment on a voided invoice', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await voidInvoice(actor(db), invoice.id, { motivo: 'error de digitación' });
    await expectError(
      () => payInvoice(actor(db), invoice.id, { method: 'efectivo', amount: 10 }),
      'access.denied',
      403,
    );
  });

  it('rejects a payment on an unknown invoice with 404', async () => {
    const db = createDb(newState());
    await expectError(
      () => payInvoice(actor(db), 'ffffffff-ffff-4fff-8fff-ffffffffffff', { method: 'efectivo', amount: 10 }),
      BILLING_ERROR.invoiceNotFound,
      404,
    );
  });
});

// ============ void ============

describe('void invoice', () => {
  it('requires a motivo', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await expectError(() => voidInvoice(actor(db), invoice.id, {}), BILLING_ERROR.reasonRequired, 400);
    await expectError(() => voidInvoice(actor(db), invoice.id, { motivo: '   ' }), BILLING_ERROR.reasonRequired, 400);
  });

  it('voids with a motivo and audits both states', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    const voided = await voidInvoice(actor(db), invoice.id, { motivo: 'anulación por error en el monto' });
    assert.equal(voided.status, 'voided');
    const audit = auditsOf(db.state, 'invoice.voided');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.diff?.motivo, 'anulación por error en el monto');
    assert.equal(audit[0]?.diff?.from, 'issued');
  });

  it('never voids an already voided invoice', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await voidInvoice(actor(db), invoice.id, { motivo: 'primera' });
    await expectError(() => voidInvoice(actor(db), invoice.id, { motivo: 'segunda' }), 'access.denied', 403);
  });
});

// ============ authorization ============

describe('authorization and scope', () => {
  it('denies a role without invoice.issue and audits the denial', async () => {
    const db = createDb(newState({ role: 'medico' }));
    seedSession(db.state);
    const body = await expectError(
      () => issueInvoice(actor(db, { userId: USER_MEDICO }), issueBody(), 'k1'),
      'access.denied',
      403,
    );
    assert.equal(body.reason, 'role.denied');
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });

  it('denies a sede outside the membership subtree', async () => {
    const db = createDb(newState());
    seedSession(db.state, SEDE_B);
    const body = await expectError(
      () => issueInvoice(actor(db), issueBody({ orgNodeId: SEDE_B }), 'k1'),
      'access.denied',
      403,
    );
    assert.equal(body.reason, 'scope.outside_subtree');
  });

  it('denies a tenant without the salud module', async () => {
    const db = createDb(newState({ modules: ['crm-core'] }));
    seedSession(db.state);
    const body = await expectError(() => issueInvoice(actor(db), issueBody(), 'k1'), 'access.denied', 403);
    assert.equal(body.reason, 'module.inactive');
  });

  it('denies a caller without an active membership', async () => {
    const db = createDb(newState({ role: 'none' }));
    seedSession(db.state);
    const body = await expectError(() => issueInvoice(actor(db), issueBody(), 'k1'), 'access.denied', 403);
    assert.equal(body.reason, 'membership.inactive');
  });
});

// ============ fiscal read ============

describe('invoice read with fiscal status', () => {
  it('exposes the fiscal pair and the payments', async () => {
    const db = createDb(newState());
    seedSession(db.state);
    const invoice = await issueInvoice(actor(db), issueBody(), 'k1');
    await payInvoice(actor(db), invoice.id, { method: 'efectivo', amount: 118 });
    const read = await getInvoiceWithFiscal(actor(db), invoice.id);
    assert.equal(read.fiscalStatus, 'pending');
    assert.equal(read.fiscalAdapter, 'manual_v1');
    assert.deepEqual(read.fiscalPayload, {});
    assert.equal(read.total, 118);
    assert.equal(read.payments.length, 1);
    assert.equal(read.payments[0]?.amount, 118);
  });

  it('returns 404 for an unknown invoice', async () => {
    const db = createDb(newState());
    await expectError(
      () => getInvoiceWithFiscal(actor(db), 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
      BILLING_ERROR.invoiceNotFound,
      404,
    );
  });
});

// ============ invoice list ============

describe('invoice list', () => {
  it('lists the invoices inside the caller scope, newest first', async () => {
    const db = createDb(newState());
    const first = seedInvoice(db.state, { created_at: '2026-03-10T09:00:00.000Z' });
    const second = seedInvoice(db.state, { created_at: '2026-03-11T09:00:00.000Z' });
    seedInvoice(db.state, { org_node_id: SEDE_B });
    const rows = await listInvoices(actor(db), {});
    assert.deepEqual(
      rows.map((row) => row.id),
      [second, first],
    );
    assert.equal(rows[0]?.status, 'issued');
  });

  it('treats empty-string filters as absent', async () => {
    const db = createDb(newState());
    seedInvoice(db.state);
    const rows = await listInvoices(actor(db), { cashSession: '', status: '', from: '', to: '' });
    assert.equal(rows.length, 1);
  });

  it('filters by cash session', async () => {
    const db = createDb(newState());
    const wanted = seedInvoice(db.state, { cash_session_id: SESSION_ID });
    seedInvoice(db.state, { cash_session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    const rows = await listInvoices(actor(db), { cashSession: SESSION_ID });
    assert.deepEqual(rows.map((row) => row.id), [wanted]);
  });

  it('filters by commercial status', async () => {
    const db = createDb(newState());
    const wanted = seedInvoice(db.state, { status: 'paid' });
    seedInvoice(db.state, { status: 'voided' });
    const rows = await listInvoices(actor(db), { status: 'paid' });
    assert.deepEqual(rows.map((row) => row.id), [wanted]);
  });

  it('filters by emission window', async () => {
    const db = createDb(newState());
    seedInvoice(db.state, { issued_at: '2026-01-05T09:00:00.000Z', created_at: '2026-01-05T09:00:00.000Z' });
    const wanted = seedInvoice(db.state, {
      issued_at: '2026-03-10T09:00:00.000Z',
      created_at: '2026-03-10T09:00:00.000Z',
    });
    seedInvoice(db.state, { issued_at: '2026-06-20T09:00:00.000Z', created_at: '2026-06-20T09:00:00.000Z' });
    const rows = await listInvoices(actor(db), { from: '2026-03-01', to: '2026-03-31' });
    assert.deepEqual(rows.map((row) => row.id), [wanted]);
  });

  it('caps the answer at 200 rows like the other list endpoints', async () => {
    const db = createDb(newState());
    seedInvoice(db.state);
    await listInvoices(actor(db), {});
    assert.equal(
      db.queries.some((query) => query.text.includes('LIMIT 200')),
      true,
      'the issued SQL carries the cap',
    );
  });

  it('rejects a malformed cashSession, status and date with 400', async () => {
    const db = createDb(newState());
    await expectError(
      () => listInvoices(actor(db), { cashSession: 'no-es-uuid' }),
      BILLING_ERROR.invalidParam,
      400,
    );
    await expectError(
      () => listInvoices(actor(db), { status: 'facturado' }),
      BILLING_ERROR.invalidParam,
      400,
    );
    await expectError(
      () => listInvoices(actor(db), { from: 'no-es-fecha' }),
      BILLING_ERROR.invalidParam,
      400,
    );
    await expectError(
      () => listInvoices(actor(db), { to: '32-13-99' }),
      BILLING_ERROR.invalidParam,
      400,
    );
  });

  it('denies a role without invoice.issue and audits the denial', async () => {
    const db = createDb(newState({ role: 'medico' }));
    seedInvoice(db.state);
    const body = await expectError(
      () => listInvoices(actor(db, { userId: USER_MEDICO }), {}),
      'access.denied',
      403,
    );
    assert.equal(body.reason, 'role.denied');
    assert.equal(auditsOf(db.state, 'access.denied').length, 1);
  });

  it('writes no audit row on a successful read', async () => {
    const db = createDb(newState());
    seedInvoice(db.state);
    await listInvoices(actor(db), {});
    assert.equal(db.state.audits.length, 0);
  });
});

// ============ quotes ============

describe('quotes', () => {
  it('creates a draft quote and audits it', async () => {
    const db = createDb(newState());
    const quote = await createQuote(actor(db), {
      orgNodeId: SEDE_A,
      customerName: 'PACIENTE DEMO UNO',
      items: [{ description: 'Consulta', quantity: 2, unitPrice: 50 }],
    });
    assert.equal(quote.status, 'draft');
    assert.equal(quote.total, 100);
    assert.equal(auditsOf(db.state, 'quote.created').length, 1);
  });

  it('lists the quotes inside the caller scope', async () => {
    const db = createDb(newState());
    await createQuote(actor(db), { orgNodeId: SEDE_A, customerName: 'A', items: [{ quantity: 1, unitPrice: 1 }] });
    const quoted = await listQuotes(actor(db));
    assert.equal(quoted.length, 1);
  });

  it('rejects a quote without items', async () => {
    const db = createDb(newState());
    await expectError(
      () => createQuote(actor(db), { orgNodeId: SEDE_A, customerName: 'A', items: [] }),
      BILLING_ERROR.invalidItems,
      400,
    );
  });
});
