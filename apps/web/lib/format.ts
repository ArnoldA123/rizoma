// Number and money formatting for the billing screens.
//
// The rule this module exists to make visible: the web *formats* money, it never
// computes it. Every amount shown in caja comes from the API (`subtotal`,
// `igvTotal`, `total`, `payments.amount`), and the only arithmetic the client
// performs is the subtraction of the pending saldo, which lives in
// `@rizoma/contracts#pendingInvoiceTotal` beside the API rule it mirrors.
//
// One `Intl.NumberFormat` per shape, created once: constructing a formatter per
// row is the usual way a table of amounts gets slow.
const PEN = new Intl.NumberFormat('es-PE', {
  style: 'currency',
  currency: 'PEN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const QUANTITY = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });

/** `S/ 59.00` — an amount as the caja prints it. */
export function formatPen(value: number): string {
  return PEN.format(Number.isFinite(value) ? value : 0);
}

/** `2.5` — a line quantity, without currency noise. */
export function formatQuantity(value: number): string {
  return QUANTITY.format(Number.isFinite(value) ? value : 0);
}

/** `18 %` — the IGV rate of a document, as the API stores it (`0.18`). */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${QUANTITY.format(rate * 100)} %`;
}

/** `12345678…` — an identifier, shortened for a list row. */
export function shortId(id: string | null | undefined): string {
  if (id === null || id === undefined || id === '') return '—';
  return `${id.slice(0, 8)}…`;
}

/**
 * Sede timestamp without a zone suffix (`25 sep 2026 11:05`): the single
 * implementation lives in `lib/salud-time.ts`, re-exported here so row code
 * keeps importing stamps from the formatting module.
 */
export { formatSedeStamp } from './salud-time.ts';

/** `25 sep 2026 16:05` (UTC) — a timestamp, or `—` when absent. */
export function formatUtcStamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}
