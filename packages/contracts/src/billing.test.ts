// Billing list contracts — `GET /v1/billing/invoices` (H4).
//
// The list answers a bare array of `invoiceRecordSchema` capped at 200 rows,
// newest first; the query carries the optional shift/status/date filters the
// service parser accepts. Synthetic payloads only, no live API involved.
// Runner: `node --test src/billing.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INVOICE_STATUSES,
  invoiceListQuerySchema,
  invoiceListSchema,
} from './index.ts';

/** Synthetic tenant/sede identifiers — demo data, never production values. */
const TENANT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

/** One invoice row exactly as `mapInvoice` emits it (synthetic data only). */
function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    tenantId: TENANT,
    orgNodeId: ORG,
    quoteId: null,
    serie: 'F001',
    numero: 1,
    customerDocType: 'dni',
    customerDocNumber: '00000001',
    customerName: 'Paciente Demo Uno',
    items: [{ description: 'Consulta', quantity: 1, unitPrice: 50 }],
    subtotal: 50,
    igvRate: 0.18,
    igvTotal: 9,
    total: 59,
    status: 'issued',
    fiscalStatus: 'pending',
    fiscalAdapter: 'manual_v1',
    fiscalPayload: {},
    cashSessionId: SESSION,
    issuedAt: '2026-09-25T16:05:00.000Z',
    createdAt: '2026-09-25T16:05:00.000Z',
    ...overrides,
  };
}

test('invoice list accepts the API array shape', () => {
  const parsed = invoiceListSchema.parse([
    invoiceRow(),
    invoiceRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      numero: 2,
      status: 'paid',
    }),
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.serie, 'F001');
  assert.equal(parsed[1]?.status, 'paid');
});

test('invoice list accepts an empty array', () => {
  assert.deepEqual(invoiceListSchema.parse([]), []);
});

test('invoice list rejects a row outside the record schema', () => {
  assert.equal(invoiceListSchema.safeParse([{ ...invoiceRow(), total: 'cincuenta' }]).success, false);
  assert.equal(invoiceListSchema.safeParse([{ ...invoiceRow(), status: 'facturado' }]).success, true);
});

test('invoice list query accepts the service filters', () => {
  const parsed = invoiceListQuerySchema.parse({
    cashSessionId: SESSION,
    status: 'issued',
    from: '2026-03-01',
    to: '2026-03-31',
  });
  assert.equal(parsed.cashSessionId, SESSION);
  assert.equal(parsed.status, 'issued');

  const empty = invoiceListQuerySchema.parse({});
  assert.equal(empty.cashSessionId, undefined);
  assert.equal(empty.status, undefined);
});

test('invoice list query rejects an unknown status and a malformed shift', () => {
  assert.equal(
    invoiceListQuerySchema.safeParse({ status: 'facturado' }).success,
    false,
    'only the commercial states travel in the query',
  );
  assert.equal(invoiceListQuerySchema.safeParse({ cashSessionId: 'no-es-uuid' }).success, false);
  for (const status of INVOICE_STATUSES) {
    assert.equal(
      invoiceListQuerySchema.safeParse({ status }).success,
      true,
      `status ${status} must travel`,
    );
  }
});
