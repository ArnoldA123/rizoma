// Fiscal adapters (peru-anexo-v1.md §3-§4, bases-consolidadas-v1.md §5.3):
// manual local folio `INT-YYYY-NNNNNN`, borrador → emitida → anulada, SUNAT beta
// with contingency degradation, IGV 18% parametrizable, retries
// 1m/5m/30m/2h/6h, idempotency by key + body. Runs with node:test, no deps.
// All identifiers are synthetic demo values.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntFolio,
  computeIGV,
  ManualAdapter,
  SunatBetaAdapter,
  createSequentialFolioCounter,
  type InvoiceInput,
  type SunatBetaAdapterOptions,
} from './adapter.ts';
import {
  nextRetryDelay,
  FISCAL_RETRY_DELAYS_SECONDS,
  decideIdempotency,
  idempotencyExpiry,
  IDEMPOTENCY_WINDOW_SECONDS,
  type IdempotencyRecord,
} from '../queues.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';

function invoice(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    serie: 'F001',
    numero: 1,
    total: 118,
    taxTotal: 18,
    igvRate: 0.18,
    ...overrides,
  };
}

describe('computeIGV', () => {
  it('applies the default 18% IGV', () => {
    assert.equal(computeIGV(100), 18);
    assert.equal(computeIGV(118), 21.24);
  });

  it('honours a custom parametrizable rate', () => {
    assert.equal(computeIGV(100, 0.1), 10);
    assert.equal(computeIGV(200, 0.05), 10);
  });

  it('rounds to 2 decimals per line', () => {
    assert.equal(computeIGV(0.1, 0.18), 0.02);
    assert.equal(computeIGV(33.33, 0.18), 6);
  });

  it('rounds per line rather than on the aggregated total', () => {
    // Two lines of 0.03 at 18%: per-line rounding gives 0.01 + 0.01 = 0.02,
    // whereas rounding the aggregated base would give 0.01.
    const perLine = computeIGV(0.03, 0.18) + computeIGV(0.03, 0.18);
    const aggregated = computeIGV(0.03 + 0.03, 0.18);
    assert.equal(perLine, 0.02);
    assert.equal(aggregated, 0.01);
    assert.notEqual(perLine, aggregated);
  });

  it('rejects a negative base', () => {
    assert.throws(() => computeIGV(-1, 0.18));
  });
});

describe('buildIntFolio', () => {
  it('builds INT-YYYY-NNNNNN with six-digit zero padding', () => {
    assert.equal(buildIntFolio(2025, 1), 'INT-2025-000001');
    assert.equal(buildIntFolio(2025, 42), 'INT-2025-000042');
    assert.equal(buildIntFolio(2024, 123456), 'INT-2024-123456');
  });

  it('rejects a non-positive or non-integer sequence', () => {
    assert.throws(() => buildIntFolio(2025, 0));
    assert.throws(() => buildIntFolio(2025, -3));
    assert.throws(() => buildIntFolio(2025, 1.5));
  });
});

describe('ManualAdapter', () => {
  const now = () => new Date('2025-03-09T12:00:00.000Z');

  it('starts a document in borrador before emission', () => {
    const adapter = new ManualAdapter({ counter: createSequentialFolioCounter(), now });
    const draft = adapter.createDraft(invoice());
    assert.equal(draft.status, 'borrador');
    assert.equal(draft.folio, null);
  });

  it('emits an internal folio and moves the document to emitida', () => {
    const adapter = new ManualAdapter({ counter: createSequentialFolioCounter(), now });
    adapter.createDraft(invoice());
    const result = adapter.emit(invoice());
    assert.equal(result.adapter, 'manual_v1');
    assert.equal(result.status, 'accepted');
    assert.equal(result.folio, 'INT-2025-000001');
    assert.equal(adapter.getDocument(invoice().id)?.status, 'emitida');
  });

  it('increments the injected counter across emissions without reuse', () => {
    const adapter = new ManualAdapter({ counter: createSequentialFolioCounter(), now });
    const first = adapter.emit(invoice({ id: 'a' }));
    const second = adapter.emit(invoice({ id: 'b' }));
    assert.equal(first.folio, 'INT-2025-000001');
    assert.equal(second.folio, 'INT-2025-000002');
  });

  it('annuls an emitted document with a motivo', () => {
    const adapter = new ManualAdapter({ counter: createSequentialFolioCounter(), now });
    adapter.emit(invoice());
    const result = adapter.annul(invoice().id, 'error de datos');
    assert.equal(result.ok, true);
    assert.equal(adapter.getDocument(invoice().id)?.status, 'anulada');
    assert.equal(adapter.getDocument(invoice().id)?.motivo, 'error de datos');
  });

  it('rejects an annulment without a motivo', () => {
    const adapter = new ManualAdapter({ counter: createSequentialFolioCounter(), now });
    adapter.emit(invoice());
    assert.equal(adapter.annul(invoice().id, '   ').ok, false);
    assert.equal(adapter.annul(invoice().id).ok, false);
    assert.equal(adapter.getDocument(invoice().id)?.status, 'emitida');
  });

  it('rejects annulling a document that is not emitida', () => {
    const adapter = new ManualAdapter({ counter: createSequentialFolioCounter(), now });
    adapter.createDraft(invoice());
    const result = adapter.annul(invoice().id, 'motivo');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_state');
  });
});

describe('SunatBetaAdapter', () => {
  const now = () => new Date('2025-03-09T12:00:00.000Z');

  function build(send: SunatBetaAdapterOptions['send']) {
    return new SunatBetaAdapter({
      send,
      folioCounter: createSequentialFolioCounter(),
      now,
    });
  }

  it('maps an accepted SUNAT response to accepted', () => {
    const adapter = build(() => ({ kind: 'accepted', ticket: 'T-1' }));
    const result = adapter.emit(invoice());
    assert.equal(result.status, 'accepted');
    assert.equal(result.adapter, 'sunat_v1');
  });

  it('maps a rejected SUNAT response to rejected with the cause', () => {
    const adapter = build(() => ({ kind: 'rejected', cause: 'RUC inválido' }));
    const result = adapter.emit(invoice());
    assert.equal(result.status, 'rejected');
    assert.equal(result.cause, 'RUC inválido');
  });

  it('degrades a timeout to contingency with an internal folio', () => {
    const adapter = build(() => ({ kind: 'timeout' }));
    const result = adapter.emit(invoice());
    assert.equal(result.status, 'contingency');
    assert.equal(result.folio, 'INT-2025-000001');
    assert.equal(result.retryDelaySeconds, FISCAL_RETRY_DELAYS_SECONDS[0]);
  });

  it('never throws a blocking error when the transport throws', () => {
    const adapter = build(() => {
      throw new Error('ECONNRESET');
    });
    const result = adapter.emit(invoice());
    assert.equal(result.status, 'contingency');
    assert.match(String(result.cause), /ECONNRESET/);
  });

  it('schedules successive contingency retries on the fiscal backoff', () => {
    const adapter = build(() => ({ kind: 'timeout' }));
    const delays: Array<number | null> = [];
    for (let i = 0; i < 6; i++) {
      delays.push(adapter.emit(invoice()).retryDelaySeconds ?? null);
    }
    assert.deepEqual(delays.slice(0, 5), [...FISCAL_RETRY_DELAYS_SECONDS]);
    assert.equal(delays[5], null);
  });

  it('freezes the raw fiscal payload for immutable audit', () => {
    const adapter = build(() => ({ kind: 'accepted' }));
    const result = adapter.emit(invoice());
    assert.equal(Object.isFrozen(result.payload), true);
    assert.equal(result.payload.invoiceId, invoice().id);
    assert.equal(result.payload.igvRate, 0.18);
  });
});

describe('fiscal retry schedule', () => {
  it('uses the exact 5-attempt backoff 1m/5m/30m/2h/6h', () => {
    assert.deepEqual([...FISCAL_RETRY_DELAYS_SECONDS], [60, 300, 1800, 7200, 21600]);
    assert.equal(nextRetryDelay('fiscal-emit', 1), 60);
    assert.equal(nextRetryDelay('fiscal-emit', 2), 300);
    assert.equal(nextRetryDelay('fiscal-emit', 3), 1800);
    assert.equal(nextRetryDelay('fiscal-emit', 4), 7200);
    assert.equal(nextRetryDelay('fiscal-emit', 5), 21600);
  });

  it('returns null once the fiscal attempts are exhausted', () => {
    assert.equal(nextRetryDelay('fiscal-emit', 6), null);
    assert.equal(nextRetryDelay('fiscal-emit', 0), null);
  });

  it('uses the 3-attempt notify backoff 1m/10m/1h', () => {
    assert.equal(nextRetryDelay('notify-send', 1), 60);
    assert.equal(nextRetryDelay('notify-send', 2), 600);
    assert.equal(nextRetryDelay('notify-send', 3), 3600);
    assert.equal(nextRetryDelay('notify-send', 4), null);
  });
});

describe('idempotency', () => {
  const nowMs = 1_000_000;

  it('replays the same response for the same key and body', () => {
    const record: IdempotencyRecord = {
      requestHash: 'hash-a',
      response: { folio: 'INT-2025-000001' },
      expiresAt: idempotencyExpiry(nowMs),
    };
    const decision = decideIdempotency(record, 'hash-a', nowMs);
    assert.deepEqual(decision, { kind: 'replay', response: { folio: 'INT-2025-000001' } });
  });

  it('reports a conflict for the same key with a different body', () => {
    const record: IdempotencyRecord = {
      requestHash: 'hash-a',
      response: { folio: 'INT-2025-000001' },
      expiresAt: idempotencyExpiry(nowMs),
    };
    assert.deepEqual(decideIdempotency(record, 'hash-b', nowMs), { kind: 'conflict' });
  });

  it('treats a missing or expired key as new and uses a 24h window', () => {
    assert.deepEqual(decideIdempotency(undefined, 'hash-a', nowMs), { kind: 'new' });
    const expired: IdempotencyRecord = {
      requestHash: 'hash-a',
      response: {},
      expiresAt: nowMs - 1,
    };
    assert.deepEqual(decideIdempotency(expired, 'hash-a', nowMs), { kind: 'new' });
    assert.equal(IDEMPOTENCY_WINDOW_SECONDS, 24 * 60 * 60);
    assert.equal(idempotencyExpiry(nowMs), nowMs + 24 * 60 * 60 * 1000);
  });
});
