// Fiscal adapters (peru-anexo-v1.md §3-§4, bases-consolidadas-v1.md §5.3).
//
// Only workers call adapters; the core holds no fiscal or provider logic. Every
// adapter returns a result instead of throwing a blocking error: a fiscal
// failure never blocks the cashier or the clinical flow, it degrades to
// `contingency` and is retried.
//
// Pure and injectable: folio counter, clock and the SUNAT transport are all
// injected, so the behavior is deterministic under test.
import { nextRetryDelay } from '../queues.ts';

export type FiscalStatus = 'pending' | 'sent' | 'accepted' | 'rejected' | 'contingency';
export type FiscalAdapterName = 'manual_v1' | 'sunat_v1';

export interface InvoiceInput {
  id: string;
  tenantId: string;
  serie: string;
  numero: number;
  total: number;
  taxTotal: number;
  igvRate: number;
}

export interface FiscalResult {
  status: FiscalStatus;
  folio: string;
  adapter: FiscalAdapterName;
  /** Raw fiscal payload kept immutable for audit and replay. */
  payload: Readonly<Record<string, unknown>>;
  /** Rejection or degradation cause, when applicable. */
  cause?: string;
  /** Scheduled retry delay in seconds; `null` once attempts are exhausted. */
  retryDelaySeconds?: number | null;
  /** Retry attempt that produced a contingency result. */
  attempt?: number;
}

export interface FiscalAdapter {
  emit(invoice: InvoiceInput): FiscalResult;
}

/** Rounds to 2 decimals (half-up) without the usual float artifacts. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Computes IGV for one line with the parametrizable rate (default 18%),
 * rounded to 2 decimals per line (peru-anexo-v1.md §3.1).
 */
export function computeIGV(base: number, rate = 0.18): number {
  if (typeof base !== 'number' || !Number.isFinite(base) || base < 0) {
    throw new RangeError('base must be a non-negative finite number');
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
    throw new RangeError('rate must be a non-negative finite number');
  }
  return round2(base * rate);
}

/** Builds the internal tenant folio `INT-YYYY-NNNNNN`. */
export function buildIntFolio(year: number, seq: number): string {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError('year must be a four-digit integer');
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > 999999) {
    throw new RangeError('seq must be an integer in 1..999999');
  }
  return `INT-${year}-${String(seq).padStart(6, '0')}`;
}

// ============ folio counter ============

export interface FolioCounter {
  next(year: number): number;
}

/** Deterministic in-memory counter; inject it so tests control folios. */
export function createSequentialFolioCounter(start = 1): FolioCounter {
  let current = start;
  return { next: () => current++ };
}

function buildFiscalPayload(
  invoice: InvoiceInput,
  adapter: FiscalAdapterName,
  folio: string | null,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    invoiceId: invoice.id,
    tenantId: invoice.tenantId,
    serie: invoice.serie,
    numero: invoice.numero,
    total: invoice.total,
    taxTotal: invoice.taxTotal,
    igvRate: invoice.igvRate,
    adapter,
    folio,
  });
}

// ============ manual adapter ============

export type ManualDocumentStatus = 'borrador' | 'emitida' | 'anulada';

export interface ManualDocument {
  invoiceId: string;
  folio: string | null;
  status: ManualDocumentStatus;
  motivo?: string;
}

export type ManualAnnulResult =
  | { ok: true; document: ManualDocument }
  | { ok: false; reason: 'not_found' | 'invalid_state' | 'motivo_required' };

export interface ManualAdapterOptions {
  counter: FolioCounter;
  now?: () => Date;
}

/**
 * Local manual invoicing (`manual_v1`, peru-anexo-v1.md §3.3): internal folio,
 * document lifecycle `borrador → emitida → anulada`, and an annulment that
 * requires a motivo. No network, no SUNAT.
 */
export class ManualAdapter implements FiscalAdapter {
  readonly adapter = 'manual_v1' as const;
  private readonly counter: FolioCounter;
  private readonly now: () => Date;
  private readonly documents = new Map<string, ManualDocument>();

  constructor(options: ManualAdapterOptions) {
    this.counter = options.counter;
    this.now = options.now ?? (() => new Date());
  }

  /** Creates (or resets) a draft for an invoice. */
  createDraft(invoice: InvoiceInput): ManualDocument {
    const document: ManualDocument = {
      invoiceId: invoice.id,
      folio: null,
      status: 'borrador',
    };
    this.documents.set(invoice.id, document);
    return document;
  }

  /** Issues the document: assigns the internal folio and moves it to emitida. */
  emit(invoice: InvoiceInput): FiscalResult {
    const document = this.documents.get(invoice.id) ?? this.createDraft(invoice);
    if (document.status === 'anulada') {
      return {
        status: 'rejected',
        folio: document.folio ?? '',
        adapter: this.adapter,
        payload: buildFiscalPayload(invoice, this.adapter, document.folio),
        cause: 'document is annulled',
      };
    }
    const year = this.now().getUTCFullYear();
    const folio = buildIntFolio(year, this.counter.next(year));
    this.documents.set(invoice.id, { ...document, status: 'emitida', folio });
    return {
      status: 'accepted',
      folio,
      adapter: this.adapter,
      payload: buildFiscalPayload(invoice, this.adapter, folio),
    };
  }

  /**
   * Annuls an emitted document. Requires a non-empty motivo; an annulled
   * document never returns to emitida.
   */
  annul(invoiceId: string, motivo?: string): ManualAnnulResult {
    const document = this.documents.get(invoiceId);
    if (!document) return { ok: false, reason: 'not_found' };
    if (document.status !== 'emitida') return { ok: false, reason: 'invalid_state' };
    if (typeof motivo !== 'string' || motivo.trim() === '') {
      return { ok: false, reason: 'motivo_required' };
    }
    const updated: ManualDocument = { ...document, status: 'anulada', motivo: motivo.trim() };
    this.documents.set(invoiceId, updated);
    return { ok: true, document: updated };
  }

  getDocument(invoiceId: string): ManualDocument | undefined {
    return this.documents.get(invoiceId);
  }
}

// ============ SUNAT beta adapter ============

export type SunatSendOutcome =
  | { kind: 'accepted'; ticket?: string }
  | { kind: 'rejected'; cause: string }
  | { kind: 'timeout'; cause?: string };

export interface SunatBetaAdapterOptions {
  /** Injected transport: returns an outcome or throws on a transport error. */
  send: (invoice: InvoiceInput, payload: Readonly<Record<string, unknown>>) => SunatSendOutcome;
  folioCounter?: FolioCounter;
  now?: () => Date;
}

function sunatFolio(invoice: InvoiceInput): string {
  return `${invoice.serie}-${String(invoice.numero).padStart(8, '0')}`;
}

/**
 * SUNAT electronic beta (`sunat_v1`, peru-anexo-v1.md §4): simulates a send
 * with an injected result. A timeout or transport error degrades to
 * `contingency` with an internal folio and a scheduled retry; a rejection is
 * surfaced as `rejected` with its cause. It never throws a blocking error.
 */
export class SunatBetaAdapter implements FiscalAdapter {
  readonly adapter = 'sunat_v1' as const;
  private readonly send: SunatBetaAdapterOptions['send'];
  private readonly folioCounter: FolioCounter;
  private readonly now: () => Date;
  private readonly attempts = new Map<string, number>();

  constructor(options: SunatBetaAdapterOptions) {
    this.send = options.send;
    this.folioCounter = options.folioCounter ?? createSequentialFolioCounter();
    this.now = options.now ?? (() => new Date());
  }

  emit(invoice: InvoiceInput): FiscalResult {
    const payload = buildFiscalPayload(invoice, this.adapter, null);
    let outcome: SunatSendOutcome;
    try {
      outcome = this.send(invoice, payload);
    } catch (error) {
      outcome = { kind: 'timeout', cause: error instanceof Error ? error.message : 'transport error' };
    }

    if (outcome.kind === 'accepted') {
      return {
        status: 'accepted',
        folio: sunatFolio(invoice),
        adapter: this.adapter,
        payload,
      };
    }

    if (outcome.kind === 'rejected') {
      return {
        status: 'rejected',
        folio: sunatFolio(invoice),
        adapter: this.adapter,
        payload,
        cause: outcome.cause,
      };
    }

    // timeout → contingency with internal folio and a scheduled retry.
    const attempt = (this.attempts.get(invoice.id) ?? 0) + 1;
    this.attempts.set(invoice.id, attempt);
    const year = this.now().getUTCFullYear();
    const folio = buildIntFolio(year, this.folioCounter.next(year));
    return {
      status: 'contingency',
      folio,
      adapter: this.adapter,
      payload,
      cause: outcome.cause,
      attempt,
      retryDelaySeconds: nextRetryDelay('fiscal-emit', attempt),
    };
  }
}
