// Live-validation rules for the Salud forms.
//
// Why this lives in `@rizoma/contracts` and not inside the web app: the rules
// are a field-by-field transcription of the API's own parsers
// (`parsePatientCreate` and `parseAppointmentCreate` in
// `apps/api/src/salud/salud.service.ts`), so the form that validates while the
// user types and the service that validates on arrival cannot drift apart. The
// tests for these functions run with `npm run test --workspace @rizoma/contracts`.
//
// Contract of the module:
//   - it is pure (no clock, no DOM, no locale): the same input yields the same
//     issue on the server and in the browser;
//   - it never throws and never returns a message: an issue is a *code*, and
//     the Spanish copy lives in the web layer (`apps/web/lib/labels.ts`), which
//     is what keeps the rule language-neutral and reusable;
//   - an empty value on an optional field is not an issue, so a form can
//     validate a half-filled draft without nagging about fields the user has
//     not reached yet.
import { INVOICE_SERIE_RE, INVOICE_DOCUMENT_DIGITS, round2 } from './billing.ts';
import { DOCUMENT_TYPES, SHA256_RE } from './salud.ts';

/** Machine-readable reasons one field can be refused. */
export type DraftIssueCode =
  | 'required'
  | 'too_long'
  | 'invalid_uuid'
  | 'invalid_date'
  | 'invalid_datetime'
  | 'invalid_document_type'
  | 'dni_digits'
  | 'invalid_sha256'
  | 'not_positive_integer'
  | 'invalid_serie'
  | 'invalid_document_number'
  | 'invalid_amount'
  | 'invalid_rate'
  | 'invalid_number'
  | 'amount_exceeds_pending';

/** One field-level refusal: the field name plus the reason code. */
export interface DraftIssue {
  readonly field: string;
  readonly code: DraftIssueCode;
}

/** One field's verdict: `null` when the value is acceptable so far. */
export type FieldCheck = DraftIssue | null;

/** `person_name` is free text; the cap keeps a pasted document out of it. */
export const PATIENT_NAME_MAX = 120;
/** `specialty` is a catalog label, not a paragraph. */
export const SPECIALTY_MAX = 80;
/** A consultation longer than eight hours is a data-entry mistake. */
export const APPOINTMENT_DURATION_MAX_MIN = 480;
/** Default duration of a scheduling form, matching the demo agenda. */
export const APPOINTMENT_DURATION_DEFAULT_MIN = 20;
/** A billing line description is a short label, not a paragraph. */
export const BILLING_DESCRIPTION_MAX = 160;
/**
 * Payment methods the caja close-totals form renders one field per. Kept here
 * and not in the contract of `payments.method` (which is free text) so the form
 * and the copy share one list.
 */
export const CASH_TOTAL_METHODS = ['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DNI_RE = /^\d{8}$/;

/** `true` for a UUID of any version, the shape every id field carries. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** `true` for a 64-character lowercase/uppercase hex SHA-256 digest. */
export function isSha256(value: string): boolean {
  return SHA256_RE.test(value.trim().toLowerCase());
}

/**
 * `true` when `YYYY-MM-DD` names a real calendar day. The shape check alone
 * accepts `2026-02-30`, which Postgres would then refuse at insert time; the
 * UTC round-trip catches it in the form instead.
 */
export function isRealUtcDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** `true` for a well-formed `datetime-local` value (`YYYY-MM-DDTHH:mm`). */
export function isDateTimeLocal(value: string): boolean {
  if (!DATETIME_LOCAL_RE.test(value)) return false;
  return isRealUtcDate(value.slice(0, 10));
}

function issue(field: string, code: DraftIssueCode): DraftIssue {
  return { field, code };
}

/** Required free text with an upper bound. */
export function checkRequiredText(field: string, value: string, max: number): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (trimmed.length > max) return issue(field, 'too_long');
  return null;
}

/** Optional free text: empty is fine, over-long is not. */
export function checkOptionalText(field: string, value: string, max: number): FieldCheck {
  const trimmed = value.trim();
  if (trimmed !== '' && trimmed.length > max) return issue(field, 'too_long');
  return null;
}

/** Required UUID of any version. */
export function checkUuidField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (!isUuid(trimmed)) return issue(field, 'invalid_uuid');
  return null;
}

/** UUID that may be left empty (the API then applies its own default). */
export function checkOptionalUuidField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!isUuid(trimmed)) return issue(field, 'invalid_uuid');
  return null;
}

/** Optional `YYYY-MM-DD` calendar date that has to name a real day. */
export function checkDateField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!isRealUtcDate(trimmed)) return issue(field, 'invalid_date');
  return null;
}

/** `datetime-local` value that has to be a real day with a time. */
export function checkDateTimeField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (!isDateTimeLocal(trimmed)) return issue(field, 'invalid_datetime');
  return null;
}

/** Document catalog of §2.3 (`dni` | `ce` | `pasaporte`). */
export function checkDocumentTypeField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(trimmed)) {
    return issue(field, 'invalid_document_type');
  }
  return null;
}

/**
 * Document number, refined by type: a `dni` is exactly eight digits, while a
 * `ce`/`pasaporte` only has to be non-empty — the same asymmetry the API
 * applies, and the reason this check needs the type beside the value.
 */
export function checkDocumentNumberField(
  field: string,
  documentType: string,
  value: string,
): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (documentType.trim() === 'dni' && !DNI_RE.test(trimmed)) {
    return issue(field, 'dni_digits');
  }
  return null;
}

/** Defensive-copy fingerprint of a signed consent. */
export function checkSha256Field(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (!isSha256(trimmed)) return issue(field, 'invalid_sha256');
  return null;
}

/** Appointment duration: a positive whole number of minutes, bounded above. */
export function checkDurationField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (!/^\d+$/.test(trimmed)) return issue(field, 'not_positive_integer');
  const minutes = Number(trimmed);
  if (minutes <= 0 || minutes > APPOINTMENT_DURATION_MAX_MIN) {
    return issue(field, 'not_positive_integer');
  }
  return null;
}

/** First non-null issue of a field map, or `null` when every field is fine. */
export function firstIssue(checks: Readonly<Record<string, FieldCheck>>): DraftIssue | null {
  for (const check of Object.values(checks)) {
    if (check !== null) return check;
  }
  return null;
}

// ============ billing live validation (W3) ============
//
// Field-for-field mirrors of the billing parsers (`parseQuoteCreate`,
// `parseInvoiceIssue`, the inline `payInvoice` / `voidInvoice` checks and
// `computeInvoiceTotals`), so the caja forms refuse locally exactly what the
// service would refuse with a 400.

const DECIMAL_RE = /^\d+(?:\.\d{1,2})?$/;
const RATE_RE = /^\d(?:\.\d+)?$/;

function parseDecimal(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '' || !DECIMAL_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Invoice `serie`: 1–8 alphanumerics. The value is uppercased first, exactly
 * like `parseInvoiceIssue` uppercases before validating, so a lowercase entry
 * is accepted here for the same reason the API accepts it.
 */
export function checkSerieField(field: string, value: string): FieldCheck {
  const trimmed = value.trim().toUpperCase();
  if (trimmed === '') return issue(field, 'required');
  if (!INVOICE_SERIE_RE.test(trimmed)) return issue(field, 'invalid_serie');
  return null;
}

/**
 * Document number, refined by type with the *billing* catalog: a `dni` carries
 * eight digits and a `ruc` eleven, while `ce`/`pasaporte` only have to be
 * non-empty — the same asymmetry `parseInvoiceIssue` applies.
 */
export function checkInvoiceDocumentNumberField(
  field: string,
  documentType: string,
  value: string,
): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  const digits = INVOICE_DOCUMENT_DIGITS[documentType.trim().toLowerCase()];
  if (digits === undefined) return null;
  if (!new RegExp(`^\\d{${digits}}$`).test(trimmed)) return issue(field, 'invalid_document_number');
  return null;
}

/** Strictly positive amount with at most 2 decimals (a line quantity). */
export function checkQuantityField(field: string, value: string): FieldCheck {
  const parsed = parseDecimal(value);
  if (parsed === null) return issue(field, value.trim() === '' ? 'required' : 'invalid_amount');
  if (parsed <= 0) return issue(field, 'invalid_amount');
  return null;
}

/** Non-negative amount with at most 2 decimals (a unit price). */
export function checkUnitPriceField(field: string, value: string): FieldCheck {
  const parsed = parseDecimal(value);
  if (parsed === null) return issue(field, value.trim() === '' ? 'required' : 'invalid_amount');
  return null;
}

/** Strictly positive amount with at most 2 decimals (a payment). */
export function checkAmountField(field: string, value: string): FieldCheck {
  const parsed = parseDecimal(value);
  if (parsed === null) return issue(field, value.trim() === '' ? 'required' : 'invalid_amount');
  if (parsed <= 0) return issue(field, 'invalid_amount');
  return null;
}

/**
 * Optional non-negative amount with at most 2 decimals. An empty value is not an
 * issue: the arqueo of a cash shift declares only the methods the cashier
 * actually counted, and an untouched field means "not counted", not "zero".
 */
export function checkOptionalAmountField(field: string, value: string): FieldCheck {
  if (value.trim() === '') return null;
  return checkUnitPriceField(field, value);
}

/** IGV rate inside the closed interval the service accepts (`0 … 1`). */export function checkIgvRateField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  if (!RATE_RE.test(trimmed)) return issue(field, 'invalid_rate');
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return issue(field, 'invalid_rate');
  return null;
}

/**
 * Payment amount against the invoice saldo: the API refuses an over-payment
 * (`billing.payment_exceeds_total`), so the form refuses it first and says how
 * much is pending instead of spending a round trip.
 */
export function checkAmountWithinPending(
  field: string,
  value: string,
  pendingTotal: number,
): FieldCheck {
  const parsed = parseDecimal(value);
  if (parsed === null) return issue(field, value.trim() === '' ? 'required' : 'invalid_amount');
  if (parsed <= 0) return issue(field, 'invalid_amount');
  if (parsed > round2(pendingTotal)) return issue(field, 'amount_exceeds_pending');
  return null;
}

/**
 * Required finite number with no upper or decimal bound.
 *
 * This is the mirror of the obras service's `requireNumber(body, key, { min: 0 })`:
 * the endpoint only asks for a finite number at least `0`, and the columns it
 * writes to (`asset_readings.value`, `stock_moves.qty`, `progress_entries.qty_done`)
 * are plain `NUMERIC` with no scale. A two-decimal check here would refuse values
 * the API accepts, which is exactly the asymmetry the form validators exist to
 * avoid.
 */
export function checkNumberField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return issue(field, 'invalid_number');
  return null;
}

/**
 * Required finite number strictly greater than `0` — the mirror of
 * `requireNumber(..., { min: 0, exclusiveMin: true })`, which is what
 * `POST /v1/obras/stock/moves` applies to `qty`: a zero-quantity move is a 400.
 */
export function checkPositiveNumberField(field: string, value: string): FieldCheck {
  const trimmed = value.trim();
  if (trimmed === '') return issue(field, 'required');
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return issue(field, 'invalid_number');
  return null;
}

/** `true` when no field of the map carries an issue. */
export function draftIsClean(checks: Readonly<Record<string, FieldCheck>>): boolean {
  return firstIssue(checks) === null;
}
