// Billing contracts — row shapes of `apps/api/src/billing/billing.service.ts`
// (bases-consolidadas-v1.md §2.5, §6.1; peru-anexo-v1.md §3).
//
// Money is a number here because that is what the API emits: the service rounds
// every line to 2 decimals before summing. The web must format, never recompute
// IGV — `computeInvoiceTotals` in the API is the single source of truth for the
// §3.1 rounding rule (sum of rounded lines, never a rounded sum).
//
// The module carries both halves of the billing surface: the *response* records
// of `/v1/billing/*` and the *request* bodies of its critical POST routes
// (cash session open/close, quote create, invoice issue/pay/void), transcribed
// from the same service so the client pre-flight and the API parser cannot
// drift. W3 is the consumer of the write half.
import { z } from 'zod';
import { isoValueSchema, jsonArraySchema, jsonObjectSchema, uuidSchema } from './common.ts';

/** Default Peruvian IGV rate (peru-anexo-v1.md §3.1). */
export const DEFAULT_IGV_RATE = 0.18;

/** `POST /v1/billing/cash-sessions/open|close` — one cashier shift. */
export const cashSessionRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  openedBy: uuidSchema,
  openedAt: isoValueSchema,
  closedAt: isoValueSchema,
  /** Per-method totals accumulated while the shift is open. */
  totals: jsonObjectSchema,
  /** `open` until the shift is closed. */
  status: z.string(),
});

export type CashSessionRecord = z.infer<typeof cashSessionRecordSchema>;

/** `GET/POST /v1/billing/quotes` — one draft quote. */
export const quoteRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  customerName: z.string(),
  items: jsonArraySchema,
  total: z.number(),
  status: z.string(),
  createdAt: isoValueSchema,
});

export type QuoteRecord = z.infer<typeof quoteRecordSchema>;

/** `GET/POST /v1/billing/invoices*` — one issued invoice. */
export const invoiceRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  quoteId: isoValueSchema,
  serie: z.string(),
  numero: z.number(),
  customerDocType: z.string(),
  customerDocNumber: z.string(),
  customerName: z.string(),
  items: jsonArraySchema,
  subtotal: z.number(),
  igvRate: z.number(),
  igvTotal: z.number(),
  total: z.number(),
  /** `issued` / `paid` / `voided`. */
  status: z.string(),
  /** Fiscal pipeline state: `pending` until the adapter accepts it. */
  fiscalStatus: z.string(),
  fiscalAdapter: z.string(),
  fiscalPayload: jsonObjectSchema,
  cashSessionId: isoValueSchema,
  issuedAt: isoValueSchema,
  createdAt: isoValueSchema,
});

export type InvoiceRecord = z.infer<typeof invoiceRecordSchema>;

/** One registered payment against an invoice. */
export const paymentRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  invoiceId: uuidSchema,
  method: z.string(),
  amount: z.number(),
  status: z.string(),
  externalRef: isoValueSchema,
  paidAt: isoValueSchema,
});

export type PaymentRecord = z.infer<typeof paymentRecordSchema>;

/** `GET /v1/billing/invoices/:id` — invoice plus fiscal pair and payments. */
export const invoiceWithFiscalSchema = invoiceRecordSchema.extend({
  payments: z.array(paymentRecordSchema),
});

export type InvoiceWithFiscal = z.infer<typeof invoiceWithFiscalSchema>;

// ============ list responses ============

/**
 * `GET /v1/billing/quotes` — bare array capped at `BILLING_LIST_LIMIT` (200).
 * There is no cursor in MVP1, so the screen paginates in the browser.
 */
export const quoteListSchema = z.array(quoteRecordSchema);
export type QuoteList = z.infer<typeof quoteListSchema>;

/**
 * `GET /v1/billing/invoices` — bare array capped at `BILLING_LIST_LIMIT` (200),
 * newest first. Same envelope as the quotes list: no cursor in MVP1, so the
 * screen paginates in the browser.
 */
export const invoiceListSchema = z.array(invoiceRecordSchema);
export type InvoiceList = z.infer<typeof invoiceListSchema>;

// ============ state catalogs ============
//
// Transcribed from the CHECK constraints of `db/migrations/004_facturacion.sql`,
// so a screen labels a status without inventing one the database would refuse.

/** `quotes.status`.
 */
export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;

/** `invoices.status` — the commercial axis.
 */
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'voided'] as const;

/** `invoices.fiscal_status` — the fiscal axis, independent of the commercial one.
 */
export const FISCAL_STATUSES = ['pending', 'sent', 'accepted', 'rejected', 'contingency'] as const;

/**
 * Query filters of `GET /v1/billing/invoices`, field-for-field what the service
 * parser (`parseInvoiceListFilters` in `billing.service.ts`) accepts: the cash
 * shift the document belongs to, the commercial status, and an emission window
 * over `COALESCE(issued_at, created_at)`. Every field is optional and an empty
 * string counts as absent, so the screen sends only the filters the user set.
 */
export const invoiceListQuerySchema = z.object({
  cashSessionId: uuidSchema.nullable().optional(),
  status: z.enum(INVOICE_STATUSES).nullable().optional(),
  from: z.string().min(1).nullable().optional(),
  to: z.string().min(1).nullable().optional(),
});
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;

/** `payments.status`.
 */
export const PAYMENT_STATUSES = ['registered', 'reconciled', 'reversed'] as const;

/**
 * Payment methods the caja screen offers. The API stores whatever string the
 * body carries (`payments.method` has no CHECK), so this is a UI catalog and
 * never a rule the contract enforces.
 */
export const PAYMENT_METHOD_SUGGESTIONS = [
  'efectivo',
  'yape',
  'plin',
  'tarjeta',
  'transferencia',
] as const;
export type PaymentMethodSuggestion = (typeof PAYMENT_METHOD_SUGGESTIONS)[number];

// ============ request bodies ============
//
// Field-for-field mirrors of the API parsers of `billing.service.ts`
// (`parseCashSessionOpen`, `parseCashSessionClose`, `parseQuoteCreate`,
// `parseInvoiceIssue`, plus the inline `payInvoice` / `voidInvoice` checks).
// They are the client-side pre-flight — the service re-validates and remains
// the only authority.

/** Document types of `invoices.customer_doc_type` (the service catalog). */
export const BILLING_DOCUMENT_TYPES = ['dni', 'ce', 'pasaporte', 'ruc'] as const;
export const billingDocumentTypeSchema = z.enum(BILLING_DOCUMENT_TYPES);
export type BillingDocumentType = z.infer<typeof billingDocumentTypeSchema>;

/** `serie`: 1–8 alphanumerics, uppercased before validation by the service. */
export const INVOICE_SERIE_MAX = 8;
export const INVOICE_SERIE_RE = /^[A-Z0-9]{1,8}$/;

/** Digits a document number must carry when the type is numeric. */
export const INVOICE_DOCUMENT_DIGITS: Readonly<Record<string, number>> = { dni: 8, ruc: 11 };

/** `serie` in its normalized form, exactly what the service stores. */
export const invoiceSerieSchema = z
  .string()
  .regex(INVOICE_SERIE_RE, 'Expected 1-8 uppercase alphanumeric characters');

/**
 * Non-empty after trimming. Every required free-text field of the service is
 * checked with `readString(...)?.trim() !== ''`, so `'  '` is a 400 there and
 * has to be a pre-flight failure here too.
 */
const nonEmptyTextSchema = z.string().refine((value) => value.trim() !== '', 'Expected non-empty text');

/**
 * One quote/invoice line, as `parseLines` reads it: a description, a strictly
 * positive quantity and a non-negative unit price. The service defaults an
 * omitted description, so the schema asks for it explicitly instead of
 * inventing copy the API would then own.
 */
export const billingLineSchema = z.object({
  description: nonEmptyTextSchema,
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative(),
});
export type BillingLine = z.infer<typeof billingLineSchema>;

/** Body of `POST /v1/billing/cash-sessions/open`. */
export const cashSessionOpenInputSchema = z.object({ orgNodeId: uuidSchema });
export type CashSessionOpenInput = z.infer<typeof cashSessionOpenInputSchema>;

/** Body of `POST /v1/billing/cash-sessions/close`. */
export const cashSessionCloseInputSchema = z.object({
  cashSessionId: uuidSchema,
  /** Per-method totals the close persists in `cash_sessions.totals`. */
  totals: jsonObjectSchema,
});
export type CashSessionCloseInput = z.infer<typeof cashSessionCloseInputSchema>;

/** Body of `POST /v1/billing/quotes`. */
export const quoteCreateInputSchema = z.object({
  orgNodeId: uuidSchema,
  customerName: nonEmptyTextSchema,
  items: z.array(billingLineSchema).min(1),
  /** Omitted: the service prices the lines; sent: it is used verbatim. */
  total: z.number().nonnegative().optional(),
});
export type QuoteCreateInput = z.infer<typeof quoteCreateInputSchema>;

/**
 * Body of `POST /v1/billing/invoices/issue`. The facade is `issued` on the
 * commercial axis with `pending` on the fiscal one; the client never sends a
 * status, a folio or a fiscal field — the service reserves the folio and the
 * adapter stays `manual_v1`.
 */
export const invoiceIssueInputSchema = z
  .object({
    orgNodeId: uuidSchema,
    /** Quote the invoice comes from, when it comes from one. */
    quoteId: uuidSchema.nullable().optional(),
    serie: invoiceSerieSchema,
    customerDocType: billingDocumentTypeSchema,
    customerDocNumber: nonEmptyTextSchema,
    customerName: nonEmptyTextSchema,
    /** Omitted: `DEFAULT_IGV_RATE` (18 %). */
    igvRate: z.number().min(0).max(1).optional(),
    /** Omitted: the service resolves the open shift of the sede. */
    cashSessionId: uuidSchema.nullable().optional(),
    items: z.array(billingLineSchema).min(1),
  })
  .refine(
    (value) => {
      const digits = INVOICE_DOCUMENT_DIGITS[value.customerDocType];
      if (digits === undefined) return true;
      return new RegExp(`^\\d{${digits}}$`).test(value.customerDocNumber);
    },
    {
      message: 'A dni carries 8 digits and a ruc 11',
      path: ['customerDocNumber'],
    },
  );
export type InvoiceIssueInput = z.infer<typeof invoiceIssueInputSchema>;

/** Body of `POST /v1/billing/invoices/:id/pay`. */
export const invoicePayInputSchema = z.object({
  /** Free text: `payments.method` has no catalog in the database. */
  method: nonEmptyTextSchema,
  /** Strictly positive; the service refuses an amount over the pending saldo. */
  amount: z.number().positive(),
  externalRef: z.string().min(1).nullable().optional(),
});
export type InvoicePayInput = z.infer<typeof invoicePayInputSchema>;

/** Body of `POST /v1/billing/invoices/:id/void` — `motivo` is mandatory (§3.3). */
export const invoiceVoidInputSchema = z.object({ motivo: nonEmptyTextSchema });
export type InvoiceVoidInput = z.infer<typeof invoiceVoidInputSchema>;

// ============ money (display arithmetic) ============
//
// These helpers never recompute IGV: the printed subtotal, IGV and total are the
// API's numbers and the web only formats them. What the caja screen does need is
// the *pending saldo* of a document — and that is the same subtraction the API
// performs when it refuses an over-payment (`SUM_PAYMENTS_SQL`, status
// `registered`), rounded the same way so the UI guess and the API verdict agree.

/** Rounds to 2 decimals (half-up), the API's own money rounding. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Sum of the payments the API counts towards the saldo (`registered`). */
export function registeredPaidTotal(payments: readonly PaymentRecord[]): number {
  let total = 0;
  for (const payment of payments) {
    if (payment.status === 'registered') total = round2(total + payment.amount);
  }
  return total;
}

/**
 * Pending saldo of an invoice: `total` minus the registered payments, floored at
 * 0. Display arithmetic, mirrored from the API check — never a reason to skip
 * the API's own refusal of an over-payment.
 */
export function pendingInvoiceTotal(
  invoice: Pick<InvoiceRecord, 'total'>,
  payments: readonly PaymentRecord[],
): number {
  return Math.max(0, round2(invoice.total - registeredPaidTotal(payments)));
}
