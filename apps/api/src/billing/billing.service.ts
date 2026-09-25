// Billing service — cash sessions, quotes, invoices and payments
// (bases-consolidadas-v1.md §2.5; docs/crm-maleable/peru-anexo-v1.md §3).
//
// Deliberately plain, like `salud/salud.service.ts`: no decorators, because
// `npm test` loads the sources through Node's strip-only TypeScript (which
// rejects decorator syntax). The HTTP skin lives in `billing.controller.ts` and
// stays thin; this module owns the use case end to end:
//   1. validate the body and normalize money;
//   2. build the guard facts (membership, org-node subtree, tenant module) and
//      evaluate the central rule through `canActivate` — which audits every
//      denial as `access.denied` — refusing on denial;
//   3. run tenant-scoped parameterized SQL (RLS already bound the request
//      transaction) and append one `audit_log` row per write.
//
// Money rules (peru-anexo-v1.md §3.1–§3.3):
//   * PEN with 2 decimals: every line is rounded half-up to 2 decimals before
//     summing, so the printed total is reproducible;
//   * IGV is parametrizable per invoice (`igv_rate`, default 18 %);
//   * the folio (`serie` + `numero`) is gapless per tenant+serie: the emission
//     locks `invoice_counters` with `SELECT ... FOR UPDATE` inside the request
//     transaction, so concurrent emissions of the same serie serialize instead
//     of colliding;
//   * a manual invoice keeps the commercial status (`draft → issued → paid` /
//     `partially_paid` / `voided`) independent from the fiscal status
//     (`pending → sent → accepted` / `rejected` / `contingency`). This module
//     only writes the fiscal defaults (`pending`, `manual_v1`); emission and
//     retries belong to the workers (base §5.3), so no adapter is imported here.
//
// IGV note (load-bearing): `computeLineIgv` below is a deliberate local
// duplicate of `computeIGV` in `apps/workers/src/fiscal/adapter.ts`
// (peru-anexo-v1.md §3.1). Only workers may import the fiscal adapters
// (base §5.3), so the API keeps its own 2-decimal formula and documents the
// source rather than reaching across the app boundary.
import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';
import { rolePermitsAction, type ActionCode } from '../auth/policy.ts';
import { SALUD_MODULE, actorFromRequest, type ActorContext, type SaludClient } from '../salud/salud.service.ts';
import { buildSavedViewConditions, resolveSavedViewForList } from '../views/views.service.ts';
import { enqueueInvoiceWebhooks } from '../webhooks/webhooks.ts';
import { NOTIFY_TEMPLATE_INVOICE_ISSUED, tryEnqueueNotify } from '../notify/notify.service.ts';

export { actorFromRequest };
export type { ActorContext, SaludClient };

/** Tenant module this vertical requires (bases §3.1 property 6 / §3.5). */
export { SALUD_MODULE };

/** Default IGV rate (peru-anexo-v1.md §3.1); stored per invoice. */
export const DEFAULT_IGV_RATE = 0.18;

/** Header carrying the client idempotency key (base §5.1). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Key window kept in `idempotency_keys` (base §5.1: 24 h). */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

/** Fiscal adapter active by default; the admin switches it per tenant (§4.3). */
export const DEFAULT_FISCAL_ADAPTER = 'manual_v1';

/** Rows a list endpoint returns at most; keeps a stray wide scan bounded. */
export const BILLING_LIST_LIMIT = 200;

// ============ keyset pagination (R1) ============

/**
 * Default/max page size for the keyset invoice listing; mirrors
 * `PAGINATION_DEFAULT_LIMIT` / `PAGINATION_MAX_LIMIT` in
 * `packages/contracts/src/pagination.ts`. The API keeps its own constants so
 * the runtime has no cross-package import; the values must stay 200/200 on
 * both sides.
 */
export const BILLING_PAGE_DEFAULT_LIMIT = BILLING_LIST_LIMIT;
export const BILLING_PAGE_MAX_LIMIT = BILLING_LIST_LIMIT;

/** One keyset page: the rows plus the opaque cursor for the next page (null = end). */
export interface BillingPage<T> {
  readonly rows: T[];
  readonly nextCursor: string | null;
}

/** Reads a non-empty pagination param from the list query, or null when absent/blank. */
function readPageParam(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Normalizes `?limit=`: absent/empty uses 200, above 200 clamps, anything else outside 1..200 is a 400. */
function parsePageLimit(raw: string | null, traceId: string): number {
  if (raw === null) return BILLING_PAGE_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw billingError(BILLING_ERROR.invalidParam, 'limit must be an integer between 1 and 200', 400, traceId);
  }
  return Math.min(parsed, BILLING_PAGE_MAX_LIMIT);
}

/** Encodes one ordering key as the opaque `nextCursor` (base64url JSON, same shape as `encodeCursor` in the contracts). */
function encodePageCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes `?cursor=` back to its ordering key; any malformed input is a 400 `billing.invalid_param`. */
function decodePageCursor(cursor: string, traceId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, traceId);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, traceId);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') {
      throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, traceId);
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, traceId);
  }
  return out;
}

/** Timestamped value (`timestamptz`) normalized to a plain string. */
type IsoValue = string | null;

// ============ error envelope ============

/** Machine-readable `billing.*` codes this module exposes. */
export const BILLING_ERROR = {
  invalidParam: 'billing.invalid_param',
  invalidSerie: 'billing.invalid_serie',
  invalidCustomer: 'billing.invalid_customer',
  invalidItems: 'billing.invalid_items',
  invalidRate: 'billing.invalid_rate',
  reasonRequired: 'billing.reason_required',
  paymentInvalid: 'billing.payment_invalid',
  paymentExceedsTotal: 'billing.payment_exceeds_total',
  idempotencyKeyRequired: 'billing.idempotency_key_required',
  idempotencyConflict: 'billing.idempotency_conflict',
  cashSessionClosed: 'billing.cash_session_closed',
  cashSessionNotFound: 'billing.cash_session_not_found',
  invoiceNotFound: 'billing.invoice_not_found',
  folioConflict: 'billing.folio_conflict',
  writeFailed: 'billing.write_failed',
} as const;
export type BillingErrorCode = (typeof BILLING_ERROR)[keyof typeof BILLING_ERROR];

/** Domain envelope: `{code: 'billing.*', message, traceId}`. */
function billingError(code: BillingErrorCode, message: string, status: number, traceId: string): HttpException {
  return new HttpException({ code, message, traceId }, status);
}

/** 403 envelope carrying the guard reason for observability. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
}

// ============ value coercion ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIE_RE = /^[A-Z0-9]{1,8}$/;
const DNI_RE = /^\d{8}$/;
const RUC_RE = /^\d{11}$/;
const DOCUMENT_TYPES = ['dni', 'ce', 'pasaporte', 'ruc'] as const;

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `pg` returns NUMERIC as string; normalize to a 2-decimal number. */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIso(value: unknown): IsoValue {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return toJsonObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toJsonArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item));
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function requireString(body: Record<string, unknown>, key: string, code: BillingErrorCode, traceId: string): string {
  const value = readString(body[key])?.trim();
  if (value === undefined || value === '') {
    throw billingError(code, `Missing required field: ${key}`, 400, traceId);
  }
  return value;
}

function optionalUuid(body: Record<string, unknown>, key: string, traceId: string): string | null {
  if (body[key] === undefined || body[key] === null) return null;
  const value = readString(body[key])?.trim() ?? '';
  if (!UUID_RE.test(value)) {
    throw billingError(BILLING_ERROR.invalidParam, `Invalid UUID in field: ${key}`, 400, traceId);
  }
  return value;
}

function requireUuidParam(value: string, label: string, traceId: string): string {
  const trimmed = value?.trim() ?? '';
  if (!UUID_RE.test(trimmed)) {
    throw billingError(BILLING_ERROR.invalidParam, `Invalid ${label}`, 400, traceId);
  }
  return trimmed;
}

// ============ money (peru-anexo-v1.md §3.1) ============

/** Rounds to 2 decimals (half-up) without the usual float artifacts. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * IGV of one line, rounded to 2 decimals. Exact duplicate of `computeIGV` in
 * `apps/workers/src/fiscal/adapter.ts` (peru-anexo-v1.md §3.1); see the file
 * header for why the API does not import the worker.
 */
export function computeLineIgv(base: number, rate: number): number {
  return round2(base * rate);
}

/** One normalized invoice line. */
export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

/** One line with its rounded base and IGV. */
export interface InvoiceLineTotal extends InvoiceLine {
  readonly lineTotal: number;
  readonly lineIgv: number;
}

/** Invoice totals: sum of rounded line values (never a single rounded sum). */
export interface InvoiceTotals {
  readonly subtotal: number;
  readonly igvTotal: number;
  readonly total: number;
  readonly lines: readonly InvoiceLineTotal[];
}

/** Computes the per-line rounded totals and their sums. */
export function computeInvoiceTotals(
  lines: readonly InvoiceLine[],
  rate: number = DEFAULT_IGV_RATE,
): InvoiceTotals {
  let subtotal = 0;
  let igvTotal = 0;
  const detailed: InvoiceLineTotal[] = [];
  for (const line of lines) {
    const lineTotal = round2(line.quantity * line.unitPrice);
    const lineIgv = computeLineIgv(lineTotal, rate);
    subtotal = round2(subtotal + lineTotal);
    igvTotal = round2(igvTotal + lineIgv);
    detailed.push({ ...line, lineTotal, lineIgv });
  }
  return { subtotal, igvTotal, total: round2(subtotal + igvTotal), lines: detailed };
}

// ============ guard facts ============

interface ActorFacts {
  readonly membership: MembershipRecord | null;
  readonly scopeSubtree: readonly string[];
  readonly moduleActive: boolean;
}

const SELECT_TENANT_MODULES_SQL = 'SELECT modules FROM tenants WHERE id = $1';

async function tenantHasModule(client: SaludClient, tenantId: string, module: string): Promise<boolean> {
  const result = await client.query(SELECT_TENANT_MODULES_SQL, [tenantId]);
  const modules = readRows(result)[0]?.modules;
  return Array.isArray(modules) && modules.includes(module);
}

const SELECT_SUBTREE_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM org_nodes WHERE tenant_id = $1 AND id = $2
  UNION ALL
  SELECT n.id FROM org_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.tenant_id = $1
)
SELECT id FROM subtree`;

async function loadScopeSubtree(client: SaludClient, tenantId: string, rootId: string): Promise<string[]> {
  const result = await client.query(SELECT_SUBTREE_SQL, [tenantId, rootId]);
  const ids: string[] = [];
  for (const row of readRows(result)) {
    if (typeof row.id === 'string') ids.push(row.id);
  }
  return ids;
}

async function loadFacts(actor: ActorContext): Promise<ActorFacts> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  const scopeSubtree =
    membership === null ? [] : await loadScopeSubtree(actor.client, actor.tenantId, membership.orgNodeId);
  const moduleActive = await tenantHasModule(actor.client, actor.tenantId, SALUD_MODULE);
  return { membership, scopeSubtree, moduleActive };
}

interface AuthorizeOptions {
  readonly entity: string;
  readonly entityId?: string | null;
  readonly orgNodeId: string;
  readonly stateAllows?: boolean;
  readonly attemptedAction?: string;
}

/**
 * Runs the single central rule (`invoice.issue` for every billing action, the
 * only billing grant the demo matrix declares, §3.3) and audits a denial before
 * throwing 403.
 */
async function authorize(
  actor: ActorContext,
  facts: ActorFacts,
  options: AuthorizeOptions,
): Promise<MembershipRecord> {
  const action: ActionCode = 'invoice.issue';
  const rolePermits = facts.membership !== null && rolePermitsAction(facts.membership.role, action);
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: actor.roles, scope: [] },
    membership: facts.membership,
    entityOrgNodeId: options.orgNodeId,
    scopeSubtree: [...facts.scopeSubtree],
    rolePermits,
    stateAllows: options.stateAllows ?? true,
    moduleActive: facts.moduleActive,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: options.entity,
      entityId: options.entityId ?? null,
      orgNodeId: options.orgNodeId,
      attemptedAction: options.attemptedAction ?? 'invoice.issue',
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return facts.membership as MembershipRecord;
}

// ============ write audit ============

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

interface AuditEntry {
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly orgNodeId: string;
  readonly diff: Record<string, unknown>;
}

/** Appends one row per successful write (§4.4); the trace id rides in `diff`. */
async function writeAudit(actor: ActorContext, membership: MembershipRecord, entry: AuditEntry): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    entry.action,
    entry.entity,
    entry.entityId,
    entry.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...entry.diff }),
    actor.ip,
  ]);
}

// ============ constraint mapping ============

const SQLSTATE_UNIQUE_VIOLATION = '23505';
const SQLSTATE_FK_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Maps a duplicate folio to a 409 instead of letting it surface as a 500. */
function mapFolioError(error: unknown, traceId: string): never {
  if (sqlState(error) === SQLSTATE_UNIQUE_VIOLATION) {
    throw billingError(BILLING_ERROR.folioConflict, 'The invoice folio already exists', 409, traceId);
  }
  if (sqlState(error) === SQLSTATE_FK_VIOLATION) {
    throw billingError(BILLING_ERROR.invoiceNotFound, 'Referenced entity does not exist', 400, traceId);
  }
  throw error;
}

// ============ row shapes ============

export interface CashSessionRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  openedBy: string;
  openedAt: IsoValue;
  closedAt: IsoValue;
  totals: Record<string, unknown>;
  status: string;
}

export interface QuoteRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  customerName: string;
  items: Record<string, unknown>[];
  total: number;
  status: string;
  createdAt: IsoValue;
}

export interface InvoiceRecord {
  id: string;
  tenantId: string;
  orgNodeId: string;
  quoteId: string | null;
  serie: string;
  numero: number;
  customerDocType: string;
  customerDocNumber: string;
  customerName: string;
  items: Record<string, unknown>[];
  subtotal: number;
  igvRate: number;
  igvTotal: number;
  total: number;
  status: string;
  fiscalStatus: string;
  fiscalAdapter: string;
  fiscalPayload: Record<string, unknown>;
  cashSessionId: string | null;
  issuedAt: IsoValue;
  createdAt: IsoValue;
}

export interface PaymentRecord {
  id: string;
  tenantId: string;
  invoiceId: string;
  method: string;
  amount: number;
  status: string;
  externalRef: string | null;
  paidAt: IsoValue;
}

/** `GET /invoices/:id` exposes the fiscal pair and the registered payments. */
export interface InvoiceWithFiscal extends InvoiceRecord {
  payments: PaymentRecord[];
}

const CASH_SESSION_COLUMNS = 'id, tenant_id, org_node_id, opened_by, opened_at, closed_at, totals, status';
const QUOTE_COLUMNS = 'id, tenant_id, org_node_id, customer_name, items, total, status, created_at';
const INVOICE_COLUMNS =
  'id, tenant_id, org_node_id, quote_id, serie, numero, customer_doc_type, customer_doc_number, customer_name, ' +
  'items, subtotal, igv_rate, igv_total, total, status, fiscal_status, fiscal_adapter, fiscal_payload, ' +
  'cash_session_id, issued_at, created_at';
const PAYMENT_COLUMNS = 'id, tenant_id, invoice_id, method, amount, status, external_ref, paid_at';

function mapCashSession(row: Record<string, unknown>): CashSessionRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    openedBy: readString(row.opened_by) ?? '',
    openedAt: toIso(row.opened_at),
    closedAt: toIso(row.closed_at),
    totals: toJsonObject(row.totals),
    status: readString(row.status) ?? '',
  };
}

function mapQuote(row: Record<string, unknown>): QuoteRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    customerName: readString(row.customer_name) ?? '',
    items: toJsonArray(row.items),
    total: toNumber(row.total),
    status: readString(row.status) ?? '',
    createdAt: toIso(row.created_at),
  };
}

function mapInvoice(row: Record<string, unknown>): InvoiceRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    orgNodeId: readString(row.org_node_id) ?? '',
    quoteId: readString(row.quote_id) ?? null,
    serie: readString(row.serie) ?? '',
    numero: toNumber(row.numero),
    customerDocType: readString(row.customer_doc_type) ?? '',
    customerDocNumber: readString(row.customer_doc_number) ?? '',
    customerName: readString(row.customer_name) ?? '',
    items: toJsonArray(row.items),
    subtotal: toNumber(row.subtotal),
    igvRate: toNumber(row.igv_rate, DEFAULT_IGV_RATE),
    igvTotal: toNumber(row.igv_total),
    total: toNumber(row.total),
    status: readString(row.status) ?? '',
    fiscalStatus: readString(row.fiscal_status) ?? 'pending',
    fiscalAdapter: readString(row.fiscal_adapter) ?? DEFAULT_FISCAL_ADAPTER,
    fiscalPayload: toJsonObject(row.fiscal_payload),
    cashSessionId: readString(row.cash_session_id) ?? null,
    issuedAt: toIso(row.issued_at),
    createdAt: toIso(row.created_at),
  };
}

function mapPayment(row: Record<string, unknown>): PaymentRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    invoiceId: readString(row.invoice_id) ?? '',
    method: readString(row.method) ?? '',
    amount: toNumber(row.amount),
    status: readString(row.status) ?? '',
    externalRef: readString(row.external_ref) ?? null,
    paidAt: toIso(row.paid_at),
  };
}

// ============ SQL ============

const INSERT_CASH_SESSION_SQL = `INSERT INTO cash_sessions
  (tenant_id, org_node_id, opened_by, status)
VALUES ($1, $2, $3, 'open')
RETURNING ${CASH_SESSION_COLUMNS}`;
const SELECT_CASH_SESSION_SQL = `SELECT ${CASH_SESSION_COLUMNS}
FROM cash_sessions WHERE tenant_id = $1 AND id = $2`;
const SELECT_OPEN_CASH_SESSION_SQL = `SELECT ${CASH_SESSION_COLUMNS}
FROM cash_sessions
WHERE tenant_id = $1 AND org_node_id = $2 AND status = 'open'
ORDER BY opened_at DESC LIMIT 1`;
const CLOSE_CASH_SESSION_SQL = `UPDATE cash_sessions
SET status = 'closed', closed_at = now(), totals = $3::jsonb
WHERE tenant_id = $1 AND id = $2 AND status = 'open'
RETURNING ${CASH_SESSION_COLUMNS}`;

const INSERT_QUOTE_SQL = `INSERT INTO quotes
  (tenant_id, org_node_id, customer_name, items, total, status)
VALUES ($1, $2, $3, $4::jsonb, $5, 'draft')
RETURNING ${QUOTE_COLUMNS}`;
const LIST_QUOTES_SQL = `SELECT ${QUOTE_COLUMNS}
FROM quotes WHERE tenant_id = $1 AND org_node_id = ANY($2::uuid[])
ORDER BY created_at DESC LIMIT ${BILLING_LIST_LIMIT}`;

const ENSURE_COUNTER_SQL = `INSERT INTO invoice_counters (tenant_id, serie, last_number)
VALUES ($1, $2, 0)
ON CONFLICT (tenant_id, serie) DO NOTHING`;
const LOCK_COUNTER_SQL = `SELECT last_number
FROM invoice_counters WHERE tenant_id = $1 AND serie = $2 FOR UPDATE`;
const INCREMENT_COUNTER_SQL = `UPDATE invoice_counters
SET last_number = last_number + 1
WHERE tenant_id = $1 AND serie = $2
RETURNING last_number`;

const CLAIM_IDEMPOTENCY_SQL = `INSERT INTO idempotency_keys
  (tenant_id, key, request_hash, response, expires_at)
VALUES ($1, $2, $3, NULL, now() + ($4 || ' hours')::interval)
ON CONFLICT (tenant_id, key) DO NOTHING
RETURNING key`;
const SELECT_IDEMPOTENCY_SQL = `SELECT request_hash, response, (expires_at > now()) AS still_valid
FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 FOR UPDATE`;
const REFRESH_IDEMPOTENCY_SQL = `UPDATE idempotency_keys
SET request_hash = $3, response = NULL, created_at = now(), expires_at = now() + ($4 || ' hours')::interval
WHERE tenant_id = $1 AND key = $2`;
const FINALIZE_IDEMPOTENCY_SQL = `UPDATE idempotency_keys
SET response = $3::jsonb
WHERE tenant_id = $1 AND key = $2`;
const DELETE_IDEMPOTENCY_SQL = `DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`;

const INSERT_INVOICE_SQL = `INSERT INTO invoices
  (tenant_id, org_node_id, quote_id, serie, numero, customer_doc_type, customer_doc_number, customer_name,
   items, subtotal, igv_rate, igv_total, total, status, fiscal_status, fiscal_adapter, fiscal_payload, cash_session_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, 'draft', 'pending', $14, '{}'::jsonb, $15)
RETURNING ${INVOICE_COLUMNS}`;
const ISSUE_INVOICE_SQL = `UPDATE invoices
SET status = 'issued', issued_at = now()
WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
RETURNING ${INVOICE_COLUMNS}`;
const SELECT_INVOICE_SQL = `SELECT ${INVOICE_COLUMNS}
FROM invoices WHERE tenant_id = $1 AND id = $2`;

const SUM_PAYMENTS_SQL = `SELECT COALESCE(SUM(amount), 0) AS paid
FROM payments WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'registered'`;
const INSERT_PAYMENT_SQL = `INSERT INTO payments
  (tenant_id, invoice_id, method, amount, status, external_ref)
VALUES ($1, $2, $3, $4, 'registered', $5)
RETURNING ${PAYMENT_COLUMNS}`;
const UPDATE_INVOICE_STATUS_SQL = `UPDATE invoices
SET status = $3
WHERE tenant_id = $1 AND id = $2 AND status IN ('issued','partially_paid')
RETURNING ${INVOICE_COLUMNS}`;
const VOID_INVOICE_SQL = `UPDATE invoices
SET status = 'voided'
WHERE tenant_id = $1 AND id = $2 AND status IN ('draft','issued','partially_paid')
RETURNING ${INVOICE_COLUMNS}`;
const LIST_PAYMENTS_SQL = `SELECT ${PAYMENT_COLUMNS}
FROM payments WHERE tenant_id = $1 AND invoice_id = $2
ORDER BY paid_at ASC, id ASC LIMIT ${BILLING_LIST_LIMIT}`;

// ============ validation ============

interface CashSessionOpenInput {
  readonly orgNodeId: string;
}

function parseCashSessionOpen(body: unknown, traceId: string): CashSessionOpenInput {
  const record = asRecord(body);
  const orgNodeId = readString(record.orgNodeId)?.trim() ?? '';
  if (!UUID_RE.test(orgNodeId)) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid UUID in field: orgNodeId', 400, traceId);
  }
  return { orgNodeId };
}

interface CashSessionCloseInput {
  readonly cashSessionId: string;
  readonly totals: Record<string, unknown>;
}

function parseCashSessionClose(body: unknown, traceId: string): CashSessionCloseInput {
  const record = asRecord(body);
  return {
    cashSessionId: requireUuidParam(readString(record.cashSessionId) ?? '', 'cash session id', traceId),
    totals: toJsonObject(record.totals),
  };
}

interface QuoteCreateInput {
  readonly orgNodeId: string;
  readonly customerName: string;
  readonly items: Record<string, unknown>[];
  readonly total: number;
}

function parseQuoteCreate(body: unknown, traceId: string): QuoteCreateInput {
  const record = asRecord(body);
  const orgNodeId = readString(record.orgNodeId)?.trim() ?? '';
  if (!UUID_RE.test(orgNodeId)) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid UUID in field: orgNodeId', 400, traceId);
  }
  const items = toJsonArray(record.items);
  if (items.length === 0) throw billingError(BILLING_ERROR.invalidItems, 'items must be a non-empty array', 400, traceId);
  const explicit = record.total;
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'number') {
    throw billingError(BILLING_ERROR.invalidItems, 'total must be a number', 400, traceId);
  }
  const total =
    typeof explicit === 'number'
      ? round2(explicit)
      : computeInvoiceTotals(parseLines(items, traceId), 0).subtotal;
  return {
    orgNodeId,
    customerName: requireString(record, 'customerName', BILLING_ERROR.invalidCustomer, traceId),
    items,
    total,
  };
}

/** Normalizes one raw line; throws `billing.invalid_items` on any bad value. */
function parseLines(items: readonly Record<string, unknown>[], traceId: string): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  for (const [index, item] of items.entries()) {
    const quantity = item.quantity;
    const unitPrice = item.unitPrice;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      throw billingError(BILLING_ERROR.invalidItems, `items[${index}].quantity must be a positive number`, 400, traceId);
    }
    if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw billingError(BILLING_ERROR.invalidItems, `items[${index}].unitPrice must be a non-negative number`, 400, traceId);
    }
    lines.push({
      description: readString(item.description)?.trim() ?? `Item ${index + 1}`,
      quantity,
      unitPrice,
    });
  }
  return lines;
}

/** Exact input of the issue use case (and the object hashed for idempotency). */
interface InvoiceIssueInput {
  readonly orgNodeId: string;
  readonly quoteId: string | null;
  readonly serie: string;
  readonly customerDocType: string;
  readonly customerDocNumber: string;
  readonly customerName: string;
  /** Optional recipient of the `invoice.issued` email; null = skip silently. */
  readonly customerEmail: string | null;
  readonly igvRate: number;
  readonly cashSessionId: string | null;
  readonly lines: InvoiceLine[];
}

function parseInvoiceIssue(body: unknown, traceId: string): InvoiceIssueInput {
  const record = asRecord(body);
  const orgNodeId = readString(record.orgNodeId)?.trim() ?? '';
  if (!UUID_RE.test(orgNodeId)) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid UUID in field: orgNodeId', 400, traceId);
  }
  const serie = (readString(record.serie)?.trim() ?? '').toUpperCase();
  if (!SERIE_RE.test(serie)) {
    throw billingError(BILLING_ERROR.invalidSerie, 'serie must be 1-8 alphanumeric characters', 400, traceId);
  }
  const customerDocType = (readString(record.customerDocType)?.trim() ?? '').toLowerCase();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(customerDocType)) {
    throw billingError(BILLING_ERROR.invalidCustomer, `Invalid customerDocType: ${customerDocType}`, 400, traceId);
  }
  const customerDocNumber = readString(record.customerDocNumber)?.trim() ?? '';
  if (customerDocType === 'dni' && !DNI_RE.test(customerDocNumber)) {
    throw billingError(BILLING_ERROR.invalidCustomer, 'A DNI customerDocNumber must be 8 digits', 400, traceId);
  }
  if (customerDocType === 'ruc' && !RUC_RE.test(customerDocNumber)) {
    throw billingError(BILLING_ERROR.invalidCustomer, 'A RUC customerDocNumber must be 11 digits', 400, traceId);
  }
  if (customerDocNumber === '') {
    throw billingError(BILLING_ERROR.invalidCustomer, 'Missing required field: customerDocNumber', 400, traceId);
  }

  let igvRate = DEFAULT_IGV_RATE;
  if (record.igvRate !== undefined && record.igvRate !== null) {
    if (typeof record.igvRate !== 'number' || !Number.isFinite(record.igvRate) || record.igvRate < 0 || record.igvRate > 1) {
      throw billingError(BILLING_ERROR.invalidRate, 'igvRate must be a number between 0 and 1', 400, traceId);
    }
    igvRate = record.igvRate;
  }

  const rawItems = toJsonArray(record.items);
  if (rawItems.length === 0) throw billingError(BILLING_ERROR.invalidItems, 'items must be a non-empty array', 400, traceId);

  // Optional `invoice.issued` recipient: the caller copies it from the patient
  // contacts when known. Absent means "no address on file" and the emitter
  // skips the notification silently; a present but malformed address is a 400
  // like any other customer field.
  const rawEmail = readString(record.customerEmail)?.trim() ?? '';
  if (rawEmail.length > 320 || (rawEmail !== '' && !rawEmail.includes('@'))) {
    throw billingError(BILLING_ERROR.invalidCustomer, 'customerEmail must be an email address', 400, traceId);
  }

  return {
    orgNodeId,
    quoteId: optionalUuid(record, 'quoteId', traceId),
    serie,
    customerDocType,
    customerDocNumber,
    customerName: requireString(record, 'customerName', BILLING_ERROR.invalidCustomer, traceId),
    customerEmail: rawEmail === '' ? null : rawEmail,
    igvRate,
    cashSessionId: optionalUuid(record, 'cashSessionId', traceId),
    lines: parseLines(rawItems, traceId),
  };
}

/** Stable digest of the issue body; the replay/conflict key of base §5.1. */
function requestHashOf(input: InvoiceIssueInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/**
 * Enqueues the `invoice.issued` email in the issue transaction (same
 * `client`, no BEGIN/COMMIT): the `queued` row commits or rolls back with
 * the invoice. Best-effort by design — a null/blank address (no email on
 * file) or a missing active template resolves silently so the emission never
 * breaks. The idempotency replay path returns before this point, so a retry
 * never double-enqueues.
 */
async function tryNotifyInvoiceIssued(
  actor: ActorContext,
  invoice: InvoiceRecord,
  customerEmail: string | null,
): Promise<void> {
  const to = customerEmail?.trim() ?? '';
  if (to === '') return;
  await tryEnqueueNotify(actor.client, actor.tenantId, {
    channel: 'email',
    template: NOTIFY_TEMPLATE_INVOICE_ISSUED,
    to,
    payload: {
      invoiceId: invoice.id,
      serie: invoice.serie,
      numero: invoice.numero,
      total: invoice.total,
      customerName: invoice.customerName,
    },
  });
}

// ============ cash sessions ============

/** Opens a cash shift for a sede (`invoice.issue`, caja only). */
export async function openCashSession(actor: ActorContext, body: unknown): Promise<CashSessionRecord> {
  const input = parseCashSessionOpen(body, actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'cash_session',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'cash_session.open',
  });
  const result = await actor.client.query(INSERT_CASH_SESSION_SQL, [
    actor.tenantId,
    input.orgNodeId,
    actor.userId,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw billingError(BILLING_ERROR.writeFailed, 'Cash session insert returned no row', 500, actor.traceId);
  }
  const session = mapCashSession(row);
  await writeAudit(actor, membership, {
    action: 'cash_session.opened',
    entity: 'cash_session',
    entityId: session.id,
    orgNodeId: session.orgNodeId,
    diff: { status: session.status },
  });
  return session;
}

/** Closes an open shift; a closed shift is not writable (`state.denied`). */
export async function closeCashSession(
  actor: ActorContext,
  body: unknown,
): Promise<CashSessionRecord> {
  const input = parseCashSessionClose(body, actor.traceId);
  const current = await findCashSession(actor, input.cashSessionId);
  if (current === null) {
    throw billingError(BILLING_ERROR.cashSessionNotFound, 'Cash session not found', 404, actor.traceId);
  }
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'cash_session',
    entityId: current.id,
    orgNodeId: current.orgNodeId,
    stateAllows: current.status === 'open',
    attemptedAction: 'cash_session.close',
  });
  const result = await actor.client.query(CLOSE_CASH_SESSION_SQL, [
    actor.tenantId,
    current.id,
    JSON.stringify(input.totals),
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw billingError(BILLING_ERROR.writeFailed, 'Cash session close returned no row', 500, actor.traceId);
  }
  const session = mapCashSession(row);
  await writeAudit(actor, membership, {
    action: 'cash_session.closed',
    entity: 'cash_session',
    entityId: session.id,
    orgNodeId: session.orgNodeId,
    diff: { from: 'open', to: 'closed', totals: session.totals },
  });
  return session;
}

async function findCashSession(actor: ActorContext, cashSessionId: string): Promise<CashSessionRecord | null> {
  const result = await actor.client.query(SELECT_CASH_SESSION_SQL, [actor.tenantId, cashSessionId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapCashSession(row);
}

/**
 * Resolves the shift the invoice belongs to: the explicit `cashSessionId` when
 * the caller sent one, otherwise the newest open shift of the sede. A closed or
 * missing shift blocks the emission (peru-anexo §3.3: no cobro without caja).
 */
async function resolveOpenCashSession(
  actor: ActorContext,
  orgNodeId: string,
  cashSessionId: string | null,
): Promise<string> {
  if (cashSessionId !== null) {
    const explicit = await findCashSession(actor, cashSessionId);
    if (explicit === null) {
      throw billingError(BILLING_ERROR.cashSessionNotFound, 'Cash session not found', 404, actor.traceId);
    }
    if (explicit.status !== 'open') {
      throw billingError(BILLING_ERROR.cashSessionClosed, 'The cash session is closed', 409, actor.traceId);
    }
    return explicit.id;
  }
  const result = await actor.client.query(SELECT_OPEN_CASH_SESSION_SQL, [actor.tenantId, orgNodeId]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw billingError(BILLING_ERROR.cashSessionClosed, 'No open cash session for the sede', 409, actor.traceId);
  }
  return readString(row.id) ?? '';
}

// ============ quotes ============

/** Creates a `draft` quote for the sede. */
export async function createQuote(actor: ActorContext, body: unknown): Promise<QuoteRecord> {
  const input = parseQuoteCreate(body, actor.traceId);
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'quote',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'quote.create',
  });
  const result = await actor.client.query(INSERT_QUOTE_SQL, [
    actor.tenantId,
    input.orgNodeId,
    input.customerName,
    JSON.stringify(input.items),
    input.total,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw billingError(BILLING_ERROR.writeFailed, 'Quote insert returned no row', 500, actor.traceId);
  }
  const quote = mapQuote(row);
  await writeAudit(actor, membership, {
    action: 'quote.created',
    entity: 'quote',
    entityId: quote.id,
    orgNodeId: quote.orgNodeId,
    diff: { total: quote.total, status: quote.status, customerName: quote.customerName },
  });
  return quote;
}

/** Filters of `GET /v1/billing/invoices`: shift, commercial status, emission window. */
export interface InvoiceListFilters {
  readonly cashSessionId: string | null;
  readonly status: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

const INVOICE_LIST_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'voided'] as const;

function readOptionalFilter(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parses the query of `GET /v1/billing/invoices`. Every filter is optional and
 * an empty string counts as absent; a malformed UUID, an unknown status or an
 * unparsable date is a 400, never a silently ignored filter.
 */
export function parseInvoiceListFilters(query: unknown, traceId: string): InvoiceListFilters {
  const record = asRecord(query);
  const rawSession = readOptionalFilter(record.cashSession ?? record.cashSessionId);
  if (rawSession !== null && !UUID_RE.test(rawSession)) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid cashSession: expected a UUID', 400, traceId);
  }
  const rawStatus = readOptionalFilter(record.status);
  if (rawStatus !== null && !(INVOICE_LIST_STATUSES as readonly string[]).includes(rawStatus)) {
    throw billingError(BILLING_ERROR.invalidParam, `Invalid status: ${rawStatus}`, 400, traceId);
  }
  const rawFrom = readOptionalFilter(record.from);
  if (rawFrom !== null && Number.isNaN(Date.parse(rawFrom))) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid from: expected a date', 400, traceId);
  }
  const rawTo = readOptionalFilter(record.to);
  if (rawTo !== null && Number.isNaN(Date.parse(rawTo))) {
    throw billingError(BILLING_ERROR.invalidParam, 'Invalid to: expected a date', 400, traceId);
  }
  return { cashSessionId: rawSession, status: rawStatus, from: rawFrom, to: rawTo };
}

/**
 * Invoices inside the membership subtree, newest first, capped at
 * `BILLING_LIST_LIMIT`. Same read contract as `listQuotes`: the guard
 * (`invoice.issue`) owns the denial audit and a successful read writes no
 * audit row — reads are not writes (§4.4).
 *
 * Keyset pagination (R1): without `?cursor=`/`?limit=` the legacy bare array
 * (cap 200) is returned unchanged. With either, the `{rows, nextCursor}`
 * page is returned instead, ordered by the stable `created_at DESC, id DESC`
 * (the legacy `ORDER BY created_at DESC` plus the `id` tiebreaker;
 * `created_at` is NOT NULL per `004_facturacion.sql`). The cursor is the
 * opaque base64url of the last row's `{createdAt, id}`; the query fetches
 * `limit + 1` rows and a non-null `nextCursor` means there is another page.
 * Every filter (`cashSession`, `status`, `from`/`to`, `?saved_view_id=`) ANDs
 * with the keyset predicate, so a filtered walk stays inside the filter.
 */
export async function listInvoices(
  actor: ActorContext,
  query: unknown,
): Promise<InvoiceRecord[] | BillingPage<InvoiceRecord>> {
  const filters = parseInvoiceListFilters(query, actor.traceId);
  const record = asRecord(query);
  const rawCursor = readPageParam(record.cursor);
  const rawLimit = readPageParam(record.limit);
  const paged = rawCursor !== null || rawLimit !== null;
  const limit = parsePageLimit(rawLimit, actor.traceId);
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  if (rawCursor !== null) {
    const payload = decodePageCursor(rawCursor, actor.traceId);
    cursorCreatedAt = payload.createdAt ?? null;
    cursorId = payload.id ?? null;
    if (cursorCreatedAt === null || cursorId === null) {
      throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, actor.traceId);
    }
    if (Number.isNaN(Date.parse(cursorCreatedAt))) {
      throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, actor.traceId);
    }
    if (!UUID_RE.test(cursorId)) {
      throw billingError(BILLING_ERROR.invalidParam, 'Invalid pagination cursor', 400, actor.traceId);
    }
  }
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'invoice',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'invoice.list',
  });
  const conditions = ['tenant_id = $1', 'org_node_id = ANY($2::uuid[])'];
  const values: unknown[] = [actor.tenantId, [...facts.scopeSubtree]];
  if (filters.cashSessionId !== null) {
    values.push(filters.cashSessionId);
    conditions.push(`cash_session_id = $${values.length}`);
  }
  if (filters.status !== null) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.from !== null) {
    values.push(filters.from);
    conditions.push(`COALESCE(issued_at, created_at) >= $${values.length}::timestamptz`);
  }
  if (filters.to !== null) {
    values.push(filters.to);
    conditions.push(`COALESCE(issued_at, created_at) <= $${values.length}::timestamptz`);
  }
  const savedViewId = readOptionalFilter(record.saved_view_id);
  if (savedViewId !== null) {
    const extra = await resolveSavedViewForList(actor, savedViewId, 'invoices');
    const { clauses, values: viewValues } = buildSavedViewConditions(
      'invoices',
      extra.filters,
      values.length + 1,
      actor.traceId,
    );
    conditions.push(...clauses);
    values.push(...viewValues);
  }
  if (cursorCreatedAt !== null && cursorId !== null) {
    values.push(cursorCreatedAt, cursorId);
    const createdAtParam = values.length - 1;
    const idParam = values.length;
    conditions.push(
      `(created_at < $${createdAtParam}::timestamptz OR ` +
        `(created_at = $${createdAtParam}::timestamptz AND id < $${idParam}::uuid))`,
    );
  }
  if (!paged) {
    const result = await actor.client.query(
      `SELECT ${INVOICE_COLUMNS} FROM invoices ` +
        `WHERE ${conditions.join(' AND ')} ` +
        `ORDER BY created_at DESC LIMIT ${BILLING_LIST_LIMIT}`,
      values,
    );
    return readRows(result).map(mapInvoice);
  }
  const result = await actor.client.query(
    `SELECT ${INVOICE_COLUMNS} FROM invoices ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
    values,
  );
  const rows = readRows(result).map(mapInvoice);
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  // `created_at` is NOT NULL, so the null branch is defensive only: without
  // an ordering key there is no cursor to offer, and ending here beats
  // emitting a cursor that the next call would reject.
  if (last === undefined || last.createdAt === null) return { rows: page, nextCursor: null };
  return { rows: page, nextCursor: encodePageCursor({ createdAt: last.createdAt, id: last.id }) };
}

/** Quotes inside the membership subtree. */
export async function listQuotes(actor: ActorContext): Promise<QuoteRecord[]> {
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'quote',
    orgNodeId: facts.membership?.orgNodeId ?? actor.tenantId,
    attemptedAction: 'quote.list',
  });
  const result = await actor.client.query(LIST_QUOTES_SQL, [actor.tenantId, [...facts.scopeSubtree]]);
  return readRows(result).map(mapQuote);
}

// ============ invoices ============

/** Reserves the next folio of a serie, gapless, inside the request transaction. */
async function nextInvoiceNumber(actor: ActorContext, serie: string): Promise<number> {
  await actor.client.query(ENSURE_COUNTER_SQL, [actor.tenantId, serie]);
  await actor.client.query(LOCK_COUNTER_SQL, [actor.tenantId, serie]);
  const result = await actor.client.query(INCREMENT_COUNTER_SQL, [actor.tenantId, serie]);
  const numero = toNumber(readRows(result)[0]?.last_number, 0);
  if (!Number.isInteger(numero) || numero < 1) {
    throw billingError(BILLING_ERROR.writeFailed, 'The invoice counter returned no number', 500, actor.traceId);
  }
  return numero;
}

/** Reads the header key; a critical POST without it is rejected (base §5.1). */
function requireIdempotencyKey(raw: string | undefined, traceId: string): string {
  const key = raw?.trim() ?? '';
  if (key === '') {
    throw billingError(
      BILLING_ERROR.idempotencyKeyRequired,
      'An Idempotency-Key header is required',
      400,
      traceId,
    );
  }
  return key;
}

/**
 * Issues an invoice: validates the open shift, computes the per-line IGV,
 * reserves the folio and writes the `draft → issued` pair. The `Idempotency-Key`
 * header makes a retry safe: the same key with the same body replays the stored
 * invoice, the same key with a different body is a 409 (base §5.1,
 * peru-anexo-v1.md §4.2).
 */
export async function issueInvoice(
  actor: ActorContext,
  body: unknown,
  idempotencyKey: string | undefined,
): Promise<InvoiceRecord> {
  const key = requireIdempotencyKey(idempotencyKey, actor.traceId);
  const input = parseInvoiceIssue(body, actor.traceId);
  const requestHash = requestHashOf(input);

  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'invoice',
    orgNodeId: input.orgNodeId,
    attemptedAction: 'invoice.issue',
  });

  const totals = computeInvoiceTotals(input.lines, input.igvRate);

  // Idempotency gate: claim the key first so two concurrent retries cannot both
  // emit. A later validation failure inside this block deletes the claim, so a
  // committed transaction never leaves a key with a null response.
  const claimed = await actor.client.query(CLAIM_IDEMPOTENCY_SQL, [
    actor.tenantId,
    key,
    requestHash,
    String(IDEMPOTENCY_WINDOW_HOURS),
  ]);
  let ownsKey = readRows(claimed).length > 0;

  try {
    if (!ownsKey) {
      const existing = await actor.client.query(SELECT_IDEMPOTENCY_SQL, [actor.tenantId, key]);
      const row = readRows(existing)[0];
      if (row !== undefined && readBoolean(row.still_valid)) {
        const storedHash = readString(row.request_hash) ?? '';
        if (storedHash !== requestHash) {
          throw billingError(
            BILLING_ERROR.idempotencyConflict,
            'The Idempotency-Key was already used with a different body',
            409,
            actor.traceId,
          );
        }
        return mapInvoice(toJsonObject(row.response));
      }
      await actor.client.query(REFRESH_IDEMPOTENCY_SQL, [
        actor.tenantId,
        key,
        requestHash,
        String(IDEMPOTENCY_WINDOW_HOURS),
      ]);
      ownsKey = true;
    }

    const cashSessionId = await resolveOpenCashSession(actor, input.orgNodeId, input.cashSessionId);
    const numero = await nextInvoiceNumber(actor, input.serie);

    const draftResult = await actor.client
      .query(INSERT_INVOICE_SQL, [
        actor.tenantId,
        input.orgNodeId,
        input.quoteId,
        input.serie,
        numero,
        input.customerDocType,
        input.customerDocNumber,
        input.customerName,
        JSON.stringify(totals.lines),
        totals.subtotal,
        input.igvRate,
        totals.igvTotal,
        totals.total,
        DEFAULT_FISCAL_ADAPTER,
        cashSessionId,
      ])
      .catch((error: unknown) => {
        mapFolioError(error, actor.traceId);
      });
    const draftRow = readRows(draftResult)[0];
    if (draftRow === undefined) {
      throw billingError(BILLING_ERROR.writeFailed, 'Invoice insert returned no row', 500, actor.traceId);
    }
    const draft = mapInvoice(draftRow);

    await writeAudit(actor, membership, {
      action: 'invoice.drafted',
      entity: 'invoice',
      entityId: draft.id,
      orgNodeId: draft.orgNodeId,
      diff: { serie: draft.serie, numero: draft.numero, total: draft.total, cashSessionId },
    });

    const issuedResult = await actor.client.query(ISSUE_INVOICE_SQL, [actor.tenantId, draft.id]);
    const issuedRow = readRows(issuedResult)[0];
    if (issuedRow === undefined) {
      throw billingError(BILLING_ERROR.writeFailed, 'Invoice issue returned no row', 500, actor.traceId);
    }
    const invoice = mapInvoice(issuedRow);
    await enqueueInvoiceWebhooks(actor.client, actor.tenantId, {
      event: 'invoice.issued',
      invoiceId: invoice.id,
      payload: { invoiceId: invoice.id, serie: invoice.serie, numero: invoice.numero, total: invoice.total },
    });
    // Best-effort `invoice.issued` email, same transaction: a missing address
    // or a missing active template skips silently, never breaking the issue.
    await tryNotifyInvoiceIssued(actor, invoice, input.customerEmail);
    await writeAudit(actor, membership, {
      action: 'invoice.issued',
      entity: 'invoice',
      entityId: invoice.id,
      orgNodeId: invoice.orgNodeId,
      diff: {
        serie: invoice.serie,
        numero: invoice.numero,
        subtotal: invoice.subtotal,
        igvRate: invoice.igvRate,
        igvTotal: invoice.igvTotal,
        total: invoice.total,
        fiscalStatus: invoice.fiscalStatus,
        fiscalAdapter: invoice.fiscalAdapter,
      },
    });

    await actor.client.query(FINALIZE_IDEMPOTENCY_SQL, [
      actor.tenantId,
      key,
      JSON.stringify(issuedRow),
    ]);
    return invoice;
  } catch (error) {
    if (ownsKey) {
      // Free the claim so the retry is not answered with a null response. A 5xx
      // path rolls the whole transaction back anyway; a 4xx path commits, so the
      // delete must be issued here.
      try {
        await actor.client.query(DELETE_IDEMPOTENCY_SQL, [actor.tenantId, key]);
      } catch {
        // best effort: the original failure is the one that must surface
      }
    }
    throw error;
  }
}

/** Registers one payment and moves the invoice to `partially_paid`/`paid`. */
export async function payInvoice(
  actor: ActorContext,
  invoiceId: string,
  body: unknown,
): Promise<InvoiceRecord> {
  const id = requireUuidParam(invoiceId, 'invoice id', actor.traceId);
  const current = await findInvoice(actor, id);
  if (current === null) {
    throw billingError(BILLING_ERROR.invoiceNotFound, 'Invoice not found', 404, actor.traceId);
  }
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'invoice',
    entityId: current.id,
    orgNodeId: current.orgNodeId,
    stateAllows: current.status === 'issued' || current.status === 'partially_paid',
    attemptedAction: 'invoice.pay',
  });

  const record = asRecord(body);
  const method = requireString(record, 'method', BILLING_ERROR.paymentInvalid, actor.traceId);
  const amount = record.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw billingError(BILLING_ERROR.paymentInvalid, 'amount must be a positive number', 400, actor.traceId);
  }
  const externalRef = readString(record.externalRef)?.trim() ?? null;

  const paidResult = await actor.client.query(SUM_PAYMENTS_SQL, [actor.tenantId, current.id]);
  const alreadyPaid = round2(toNumber(readRows(paidResult)[0]?.paid));
  const paymentAmount = round2(amount);
  const newPaid = round2(alreadyPaid + paymentAmount);
  if (newPaid > current.total) {
    throw billingError(
      BILLING_ERROR.paymentExceedsTotal,
      `Payment of ${paymentAmount} exceeds the pending ${round2(current.total - alreadyPaid)}`,
      400,
      actor.traceId,
    );
  }

  const paymentResult = await actor.client.query(INSERT_PAYMENT_SQL, [
    actor.tenantId,
    current.id,
    method,
    paymentAmount,
    externalRef,
  ]);
  const paymentRow = readRows(paymentResult)[0];
  if (paymentRow === undefined) {
    throw billingError(BILLING_ERROR.writeFailed, 'Payment insert returned no row', 500, actor.traceId);
  }
  const payment = mapPayment(paymentRow);
  await writeAudit(actor, membership, {
    action: 'payment.registered',
    entity: 'payment',
    entityId: payment.id,
    orgNodeId: current.orgNodeId,
    diff: { invoiceId: current.id, method: payment.method, amount: payment.amount, status: payment.status },
  });

  const nextStatus = newPaid >= current.total ? 'paid' : 'partially_paid';
  const updated = await actor.client.query(UPDATE_INVOICE_STATUS_SQL, [
    actor.tenantId,
    current.id,
    nextStatus,
  ]);
  const updatedRow = readRows(updated)[0];
  if (updatedRow === undefined) {
    throw billingError(BILLING_ERROR.writeFailed, 'Invoice payment update returned no row', 500, actor.traceId);
  }
  const invoice = mapInvoice(updatedRow);
  await enqueueInvoiceWebhooks(actor.client, actor.tenantId, {
    event: 'invoice.paid',
    invoiceId: invoice.id,
    payload: { invoiceId: invoice.id, status: invoice.status, paid: newPaid, total: invoice.total },
  });
  await writeAudit(actor, membership, {
    action: 'invoice.paid',
    entity: 'invoice',
    entityId: invoice.id,
    orgNodeId: invoice.orgNodeId,
    diff: { status: invoice.status, paid: newPaid, total: invoice.total, paymentId: payment.id },
  });
  return invoice;
}

/** Voids an invoice with a mandatory motivo (peru-anexo-v1.md §3.3). */
export async function voidInvoice(
  actor: ActorContext,
  invoiceId: string,
  body: unknown,
): Promise<InvoiceRecord> {
  const id = requireUuidParam(invoiceId, 'invoice id', actor.traceId);
  const current = await findInvoice(actor, id);
  if (current === null) {
    throw billingError(BILLING_ERROR.invoiceNotFound, 'Invoice not found', 404, actor.traceId);
  }
  const facts = await loadFacts(actor);
  const membership = await authorize(actor, facts, {
    entity: 'invoice',
    entityId: current.id,
    orgNodeId: current.orgNodeId,
    stateAllows: current.status === 'draft' || current.status === 'issued' || current.status === 'partially_paid',
    attemptedAction: 'invoice.void',
  });

  const motivo = readString(asRecord(body).motivo)?.trim() ?? '';
  if (motivo === '') {
    throw billingError(
      BILLING_ERROR.reasonRequired,
      'A motivo is required to void an invoice',
      400,
      actor.traceId,
    );
  }

  const result = await actor.client.query(VOID_INVOICE_SQL, [actor.tenantId, current.id]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw billingError(BILLING_ERROR.writeFailed, 'Invoice void returned no row', 500, actor.traceId);
  }
  const invoice = mapInvoice(row);
  await enqueueInvoiceWebhooks(actor.client, actor.tenantId, {
    event: 'invoice.voided',
    invoiceId: invoice.id,
    payload: { invoiceId: invoice.id, from: current.status, to: 'voided' },
  });
  await writeAudit(actor, membership, {
    action: 'invoice.voided',
    entity: 'invoice',
    entityId: invoice.id,
    orgNodeId: invoice.orgNodeId,
    diff: { from: current.status, to: 'voided', motivo },
  });
  return invoice;
}

async function findInvoice(actor: ActorContext, invoiceId: string): Promise<InvoiceRecord | null> {
  const result = await actor.client.query(SELECT_INVOICE_SQL, [actor.tenantId, invoiceId]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapInvoice(row);
}

/** Reads one invoice with its fiscal pair and registered payments. */
export async function getInvoiceWithFiscal(
  actor: ActorContext,
  invoiceId: string,
): Promise<InvoiceWithFiscal> {
  const id = requireUuidParam(invoiceId, 'invoice id', actor.traceId);
  const current = await findInvoice(actor, id);
  if (current === null) {
    throw billingError(BILLING_ERROR.invoiceNotFound, 'Invoice not found', 404, actor.traceId);
  }
  const facts = await loadFacts(actor);
  await authorize(actor, facts, {
    entity: 'invoice',
    entityId: current.id,
    orgNodeId: current.orgNodeId,
    attemptedAction: 'invoice.open',
  });
  const paymentsResult = await actor.client.query(LIST_PAYMENTS_SQL, [actor.tenantId, current.id]);
  return { ...current, payments: readRows(paymentsResult).map(mapPayment) };
}
