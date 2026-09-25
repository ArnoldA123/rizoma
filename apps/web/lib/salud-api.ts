// Browser API client for the Salud vertical and the billing surface it owns.
//
// One module owns the path, the verb, the contract schema and the replay key of
// every call a Salud screen makes, so a screen never assembles a URL or a body
// by hand. Three rules are enforced here and nowhere else:
//
//   1. The response is parsed with the `@rizoma/contracts` schema of its
//      endpoint. A drift fails at the edge with `api.contract_mismatch` instead
//      of surfacing `undefined` deep inside a list row.
//   2. A critical mutation (`POST`, and the two consent lifecycle steps) gets a
//      fresh `Idempotency-Key` per *user intent*. The key is generated inside
//      the call on purpose: call it once per click and never inside a retry
//      loop — collapsing the replay is exactly what the key is for. The one
//      deliberate exception is the CSV importer, whose key is the SHA-256 of the
//      file bytes, because the API's own replay key is that hash.
//   3. The request body is pre-flighted with the same schema the API service
//      validates against, so an invalid payload is refused in the browser with
//      the local rule instead of costing a round trip.
//
// Errors are never swallowed: `ApiRequestError` carries `{code, reason,
// traceId}` and the caller classifies it with `lib/salud-errors.ts`.
//
// The file-hash helper lives in `lib/browser-hash.ts` since W5: the obras
// importers use the same digest as the replay key, and one implementation of
// "SHA-256 of these bytes" is better than two that can drift.
import {
  appointmentCreateInputSchema,
  appointmentListSchema,
  appointmentRecordSchema,
  cashSessionCloseInputSchema,
  cashSessionOpenInputSchema,
  cashSessionRecordSchema,
  consentCreateInputSchema,
  consentListSchema,
  consentRecordSchema,
  consentSignInputSchema,
  episodeCreateInputSchema,
  episodeListSchema,
  episodeRecordSchema,
  importJobRecordSchema,
  invoiceIssueInputSchema,
  invoicePayInputSchema,
  invoiceRecordSchema,
  invoiceVoidInputSchema,
  invoiceWithFiscalSchema,
  patientCreateInputSchema,
  patientListSchema,
  patientRecordSchema,
  patientsImportInputSchema,
  quoteCreateInputSchema,
  quoteListSchema,
  quoteRecordSchema,
  saludBoardQueryString,
  saludDashboardBoardSchema,
  type AppointmentCreateInput,
  type AppointmentRecord,
  type CashSessionCloseInput,
  type CashSessionOpenInput,
  type CashSessionRecord,
  type ConsentCreateInput,
  type ConsentRecord,
  type ConsentSignInput,
  type DashboardRole,
  type EpisodeCreateInput,
  type EpisodeRecord,
  type ImportJobRecord,
  type InvoiceIssueInput,
  type InvoicePayInput,
  type InvoiceRecord,
  type InvoiceVoidInput,
  type InvoiceWithFiscal,
  type PatientCreateInput,
  type PatientRecord,
  type PatientsImportInput,
  type QuoteCreateInput,
  type QuoteRecord,
  type SaludBoardQuery,
  type SaludDashboardBoard,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { apiErrorFromResponse, newIdempotencyKey, proxyRequest, requestJson } from './api-client.ts';
import { sha256Hex } from './browser-hash.ts';
import { errorsCsvFilename } from './salud-download.ts';

/** Base path of the vertical, mirroring `@Controller('salud/...')`. */
const BASE = '/salud';

/** Base path of the billing controller (`@Controller('billing')`). */
const BILLING = '/billing';

/**
 * Reads a list endpoint. The API answers a bare array capped at 200 rows; an
 * empty body is normalized to `[]` so a screen can distinguish "no rows" (a
 * typed empty state) from "could not read" (a failure panel).
 */
async function readList<T>(
  path: string,
  schema: ZodType<T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  const rows = await requestJson(path, schema, signal === undefined ? {} : { signal });
  return rows ?? [];
}

/** Reads one record; the API answers 404 with a typed envelope when absent. */
async function readOne<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
  const record = await requestJson(path, schema, signal === undefined ? {} : { signal });
  if (record === null) {
    // A 2xx with an empty body on a by-id read is a contract violation, not a
    // missing record; surfacing it as a failure is the honest behaviour.
    throw new Error(`El API respondió sin cuerpo para ${path}`);
  }
  return record;
}

// ============ patients ============

/** `GET /v1/salud/patients` — requires `patient.read`. */
export function listPatients(signal?: AbortSignal): Promise<PatientRecord[]> {
  return readList(`${BASE}/patients`, patientListSchema, signal);
}

/** `POST /v1/salud/patients` — requires `patient.write`. */
export function createPatient(input: PatientCreateInput): Promise<PatientRecord> {
  const body = patientCreateInputSchema.parse(input);
  return postJson(`${BASE}/patients`, body, patientRecordSchema);
}

/** `GET /v1/salud/patients/:id` — requires `patient.read`. */
export function getPatient(patientId: string, signal?: AbortSignal): Promise<PatientRecord> {
  return readOne(`${BASE}/patients/${encodeURIComponent(patientId)}`, patientRecordSchema, signal);
}

// ============ consents ============

/** `GET /v1/salud/consents?patient=` — requires `patient.read`. */
export function listConsents(patientId: string, signal?: AbortSignal): Promise<ConsentRecord[]> {
  return readList(
    `${BASE}/consents?patient=${encodeURIComponent(patientId)}`,
    consentListSchema,
    signal,
  );
}

/** `POST /v1/salud/consents` — creates the `pending` row (`patient.write`). */
export function createConsent(input: ConsentCreateInput): Promise<ConsentRecord> {
  const body = consentCreateInputSchema.parse(input);
  return postJson(`${BASE}/consents`, body, consentRecordSchema);
}

/** `POST /v1/salud/consents/:id/sign` — attaches the evidence and signs. */
export function signConsent(consentId: string, input: ConsentSignInput): Promise<ConsentRecord> {
  const body = consentSignInputSchema.parse(input);
  return postJson(
    `${BASE}/consents/${encodeURIComponent(consentId)}/sign`,
    body,
    consentRecordSchema,
  );
}

/** `POST /v1/salud/consents/:id/revoke` — `signed → revoked`. */
export function revokeConsent(consentId: string): Promise<ConsentRecord> {
  return postJson(`${BASE}/consents/${encodeURIComponent(consentId)}/revoke`, {}, consentRecordSchema);
}

// ============ episodes ============

/** `GET /v1/salud/episodes` — episodes of the caller scope (`patient.read`). */
export function listEpisodes(signal?: AbortSignal): Promise<EpisodeRecord[]> {
  return readList(`${BASE}/episodes`, episodeListSchema, signal);
}

/** `POST /v1/salud/episodes` — opens an episode (`episode.write`). */
export function createEpisode(input: EpisodeCreateInput): Promise<EpisodeRecord> {
  const body = episodeCreateInputSchema.parse(input);
  return postJson(`${BASE}/episodes`, body, episodeRecordSchema);
}

/** `PATCH /v1/salud/episodes/:id` — closes an episode (`episode.write`). */
export async function closeEpisode(episodeId: string): Promise<EpisodeRecord> {
  const record = await requestJson(
    `${BASE}/episodes/${encodeURIComponent(episodeId)}`,
    episodeRecordSchema,
    { method: 'PATCH', idempotencyKey: newIdempotencyKey() },
  );
  if (record === null) throw new Error('El cierre de episodio no devolvió cuerpo.');
  return record;
}

// ============ appointments ============

/** `GET /v1/salud/appointments` — agenda of the caller scope (`agenda.read`). */
export function listAppointments(signal?: AbortSignal): Promise<AppointmentRecord[]> {
  return readList(`${BASE}/appointments`, appointmentListSchema, signal);
}

/** `POST /v1/salud/appointments` — schedules a visit (`appointment.write`). */
export function createAppointment(input: AppointmentCreateInput): Promise<AppointmentRecord> {
  const body = appointmentCreateInputSchema.parse(input);
  return postJson(`${BASE}/appointments`, body, appointmentRecordSchema);
}

// ============ POST plumbing ============

/**
 * One JSON `POST` with a replay key and the endpoint's schema. The key is fresh
 * per *user intent* by default; a caller that owns a better identity for the
 * intent (the CSV importer, whose key is the file hash) passes it in. Kept last
 * so the exported surface above reads as the endpoint list of the vertical.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  schema: ZodType<T>,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<T> {
  const record = await requestJson(path, schema, {
    method: 'POST',
    body,
    idempotencyKey,
  });
  if (record === null) throw new Error(`El API respondió sin cuerpo para ${path}`);
  return record;
}

// ============ billing: cash sessions ============

/** `POST /v1/billing/cash-sessions/open` — opens the shift (`invoice.issue`). */
export function openCashSession(input: CashSessionOpenInput): Promise<CashSessionRecord> {
  const body = cashSessionOpenInputSchema.parse(input);
  return postJson(`${BILLING}/cash-sessions/open`, body, cashSessionRecordSchema);
}

/** `POST /v1/billing/cash-sessions/close` — closes an open shift. */
export function closeCashSession(input: CashSessionCloseInput): Promise<CashSessionRecord> {
  const body = cashSessionCloseInputSchema.parse(input);
  return postJson(`${BILLING}/cash-sessions/close`, body, cashSessionRecordSchema);
}

// ============ billing: quotes ============

/** `GET /v1/billing/quotes` — quotes of the caller scope, capped at 200 rows. */
export function listQuotes(signal?: AbortSignal): Promise<QuoteRecord[]> {
  return readList(`${BILLING}/quotes`, quoteListSchema, signal);
}

/** `POST /v1/billing/quotes` — creates a `draft` quote. */
export function createQuote(input: QuoteCreateInput): Promise<QuoteRecord> {
  const body = quoteCreateInputSchema.parse(input);
  return postJson(`${BILLING}/quotes`, body, quoteRecordSchema);
}

// ============ billing: invoices ============

/**
 * `POST /v1/billing/invoices/issue` — emits an invoice with a fresh
 * `Idempotency-Key` per intent. Call it once per click and never inside a
 * retry loop: collapsing the replay is exactly what the key is for.
 */
export function issueInvoice(input: InvoiceIssueInput): Promise<InvoiceRecord> {
  const body = invoiceIssueInputSchema.parse(input);
  return postJson(`${BILLING}/invoices/issue`, body, invoiceRecordSchema);
}

/** `POST /v1/billing/invoices/:id/pay` — registers one payment. */
export function payInvoice(invoiceId: string, input: InvoicePayInput): Promise<InvoiceRecord> {
  const body = invoicePayInputSchema.parse(input);
  return postJson(
    `${BILLING}/invoices/${encodeURIComponent(invoiceId)}/pay`,
    body,
    invoiceRecordSchema,
  );
}

/** `POST /v1/billing/invoices/:id/void` — voids the invoice with a `motivo`. */
export function voidInvoice(invoiceId: string, input: InvoiceVoidInput): Promise<InvoiceRecord> {
  const body = invoiceVoidInputSchema.parse(input);
  return postJson(
    `${BILLING}/invoices/${encodeURIComponent(invoiceId)}/void`,
    body,
    invoiceRecordSchema,
  );
}

/** `GET /v1/billing/invoices/:id` — invoice + fiscal pair + payments. */
export function getInvoice(invoiceId: string, signal?: AbortSignal): Promise<InvoiceWithFiscal> {
  return readOne(
    `${BILLING}/invoices/${encodeURIComponent(invoiceId)}`,
    invoiceWithFiscalSchema,
    signal,
  );
}

// ============ patients CSV import ============

/**
 * `POST /v1/salud/imports/patients` — imports a patients CSV (`patient.write`).
 *
 * The `Idempotency-Key` is the SHA-256 of the CSV bytes, not a random uuid: the
 * service derives its own replay key from that hash (§5.4), so a re-upload of
 * the same file — from a fresh page, another browser, or after a failure — has
 * to collapse into the original job. A per-click key would import the same
 * bytes twice.
 */
export async function importPatientsCsv(input: PatientsImportInput): Promise<ImportJobRecord> {
  const body = patientsImportInputSchema.parse(input);
  return postJson(`${BASE}/imports/patients`, body, importJobRecordSchema, await sha256Hex(body.csv));
}

/** `GET /v1/salud/imports/:id` — job detail, errors CSV included. */
export function getImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJobRecord> {
  return readOne(`${BASE}/imports/${encodeURIComponent(jobId)}`, importJobRecordSchema, signal);
}

/** One materialized errors-CSV download. */
export interface ImportErrorsDownload {
  readonly filename: string;
  readonly csv: string;
}

/**
 * Reads the errors CSV of a job through the proxy and names the file.
 *
 * Why a second read of a job the screen already holds: the CSV is a *download*
 * of the run, not a rendering of it, and the proxy is the one path that carries
 * `content-disposition` (it forwards the header). Today the API answers JSON and
 * the text is materialized in the browser; the day the errors CSV is streamed
 * as an attachment, the same call already returns the upstream filename. A run
 * without refused rows answers `null`, so the button is never offered.
 */
export async function fetchImportErrorsCsv(jobId: string): Promise<ImportErrorsDownload | null> {
  const path = `${BASE}/imports/${encodeURIComponent(jobId)}`;
  const response = await proxyRequest(path);
  if (!response.ok) throw await apiErrorFromResponse(response);

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  const parsed = importJobRecordSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('La respuesta del API no cumple el contrato de importación.');
  }
  const job = parsed.data;
  if (job.errorsCsv === null) return null;
  return {
    filename: errorsCsvFilename(job.id, response.headers.get('content-disposition')),
    csv: job.errorsCsv,
  };
}

// ============ role dashboards ============

/**
 * `GET /v1/salud/dashboards/:role?org=&date=` — the board of the caller's role.
 * The API refuses a board the caller does not own with `role.denied`, so the
 * screens only ask for `boardRoleFor(role)`.
 */
export function getSaludBoard(
  role: DashboardRole,
  query: SaludBoardQuery = {},
  signal?: AbortSignal,
): Promise<SaludDashboardBoard> {
  const path = `${BASE}/dashboards/${encodeURIComponent(role)}${saludBoardQueryString(query)}`;
  return readOne(path, saludDashboardBoardSchema, signal);
}
