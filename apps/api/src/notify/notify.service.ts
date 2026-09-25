// Tenant notification service over `message_log` + `notify_templates` (N1).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the management use case end to end:
//   1. build the actor from the request the tenant middleware already bound;
//   2. load the membership + org subtree and run the central rule through
//      `canActivate` — which audits every denial as `access.denied`;
//   3. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every management write, append one `audit_log` row.
//
// SQL mapping note: bases documents this service over a `to` column, but the
// real SQL (`db/migrations/001_core_foundation.sql`) declares `recipient`.
// The public contract therefore names the destination `to` and this service
// maps `to` (contract) → `recipient` (SQL) on every write, and `recipient`
// (SQL) → `to` (contract) on every read. The `recipient` column name never
// reaches the wire.
//
// Outbox contract (same shape as the webhook fan-out in `webhooks.ts`):
// - `enqueueNotify` runs INSIDE the business transaction of the emitter
//   (same `client`, no BEGIN/COMMIT here): the `queued` row commits or rolls
//   back atomically with the business write. It runs no guard on purpose:
//   the emitter already authorized the business action, and the row stays
//   within the same tenant. A worker moves the row through
//   `queued → sent → delivered|failed` via `markSent/markDelivered/markFailed`.
// - `enqueueNotify` fails fast (400) when no `active` template exists for the
//   `(channel, code)` pair, so a typo never queues a dead row. The payload is
//   transient: `message_log` stores no body, so the worker re-renders the
//   active template at send time with `renderNotifyTemplate`.
// - `POST /v1/notify/send` is the direct management path: same insert, behind
//   the tenant-admin gate, with one `audit_log` row per enqueue.
// - Status transitions are worker-owned: `mark*` writes no audit row, and the
//   API exposes no transition endpoint — the controller is send/list only.
//
// Required templates (one `active` version per `(channel, code)` pair, seeded
// per tenant by the tenant provisioning — there is no versioned catalog-seed
// mechanism for `notify_templates` (`db/seeds/` holds per-vertical demo data
// only). Until the rows exist, `enqueueNotify` fails fast and the emitters
// below skip silently through `tryEnqueueNotify`:
//   * `('email', 'invoice.issued')` — body with `{{serie}}`, `{{numero}}`,
//     `{{total}}`, `{{customerName}}` and `{{invoiceId}}` slots;
//   * `('email' | 'sms', 'appointment.scheduled')` — body with
//     `{{appointmentId}}`, `{{patientId}}`, `{{startsAt}}` and
//     `{{durationMin}}` slots (one active version per channel).
//
// Onboarding note: the first-run wizard close (`onboarding/store.ts`) is
// pre-tenant, so it emits nothing — `message_log.tenant_id` is NOT NULL and
// there is no tenant to scope the row to. Same rationale as the webhook
// fan-out (`webhooks.ts`): the tenant provisioning that persists the acta
// owns `onboarding.closed` and any future welcome notification.
import { HttpException } from '@nestjs/common';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';

/** Channels the service enqueues (`message_log.channel`). */
export const NOTIFY_CHANNELS = ['email', 'sms', 'whatsapp'] as const;

export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** Delivery lifecycle the worker moves through (`message_log.status`). */
export const NOTIFY_STATUSES = ['queued', 'sent', 'delivered', 'failed'] as const;

export type NotifyStatus = (typeof NOTIFY_STATUSES)[number];

/** Template lifecycle (`notify_templates.status`). */
export const NOTIFY_TEMPLATE_STATUSES = ['draft', 'active', 'retired'] as const;

export type NotifyTemplateStatus = (typeof NOTIFY_TEMPLATE_STATUSES)[number];

/** Roles allowed to manage notifications (same custodians as API keys). */
export const NOTIFY_ADMIN_ROLES = ['ti_admin', 'direccion'] as const;

/**
 * Template `code` the billing emitter enqueues on `invoice.issued`
 * (channel `email`). Mirrored in `packages/contracts/src/notify.ts`.
 */
export const NOTIFY_TEMPLATE_INVOICE_ISSUED = 'invoice.issued';

/**
 * Template `code` the salud emitter enqueues on `appointment.created`
 * (channel `email` when the patient has an email, `sms` when only a phone
 * is on file). Mirrored in `packages/contracts/src/notify.ts`.
 */
export const NOTIFY_TEMPLATE_APPOINTMENT_SCHEDULED = 'appointment.scheduled';

/** Rows a list endpoint returns at most; keeps a stray wide scan bounded. */
export const NOTIFY_LIST_LIMIT = 200;

/** Longest destination address the service stores (mirrors the contract). */
const MAX_TO_LENGTH = 320;

/** Longest template code the service stores (mirrors the contract). */
const MAX_TEMPLATE_LENGTH = 120;

/** Longest template body the service stores (mirrors the contract). */
const MAX_BODY_LENGTH = 8000;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface NotifyClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Framework-free request shape the controller forwards (structural). */
export interface NotifyRequest {
  headers?: Record<string, string | string[] | undefined>;
  tenant?: { tenantId: string; userId: string; scopes: readonly string[] };
  tenantClient?: NotifyClient;
}

/** Everything a use case needs from the request, framework-free. */
export interface NotifyActor {
  readonly client: NotifyClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly traceId: string;
  readonly ip: string | null;
}

/** One `message_log` row as the API returns it (`to` = SQL `recipient`). */
export interface NotifyMessageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: string;
  readonly template: string;
  /** Destination address; persisted in the SQL `recipient` column. */
  readonly to: string;
  readonly status: string;
  readonly cost: number;
  readonly providerRef: string | null;
  readonly createdAt: string | null;
}

/** One `notify_templates` row as the API returns it. */
export interface NotifyTemplateRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly channel: string;
  readonly code: string;
  readonly version: number;
  readonly body: string;
  readonly status: string;
}

/** Input of the same-tx enqueue writer (emitters) and the direct send. */
export interface NotifyEnqueueInput {
  readonly channel: string;
  /** Active template `code` looked up in `notify_templates`. */
  readonly template: string;
  /** Destination address; stored in the SQL `recipient` column. */
  readonly to: string;
  /** Variables rendered into the `{{var}}` slots of the template body. */
  readonly payload?: Record<string, unknown>;
}

/** Filters of `GET /v1/notify/messages` — every filter is optional. */
export interface NotifyMessageFilters {
  readonly channel: string | null;
  readonly status: string | null;
}

/** Validated `POST /v1/notify/templates` body. */
export interface NotifyTemplateCreateInput {
  readonly channel: string;
  readonly code: string;
  readonly body: string;
  readonly version: number;
  readonly status: string;
}

/** Filters of `GET /v1/notify/templates` — defaults to `active` only. */
export interface NotifyTemplateFilters {
  readonly status: string | null;
}

/** Optional worker-reported facts recorded on a status transition. */
export interface NotifyMarkInput {
  readonly cost?: number;
  readonly providerRef?: string;
}

/** True for the two tenant admin roles that may manage notifications. */
export function isNotifyAdminRole(role: string): boolean {
  return (NOTIFY_ADMIN_ROLES as readonly string[]).includes(role);
}

/**
 * Renders a template body, replacing every `{{var}}` slot with the string
 * form of `payload[var]`. Unknown or nullish variables render as an empty
 * string; surrounding whitespace inside the braces is ignored, so
 * `{{ name }}` and `{{name}}` are the same slot.
 */
export function renderNotifyTemplate(body: string, payload: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>(
      (current, part) => {
        if (typeof current !== 'object' || current === null) return undefined;
        return (current as Record<string, unknown>)[part];
      },
      payload,
    );
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

// ============ error envelope ============

/** 403 envelope carrying the guard reason for observability. */
function accessDenied(reason: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'access.denied', message: `Access denied: ${reason}`, reason, traceId },
    403,
  );
}

/** 400 envelope for a body/param that fails validation. */
function badRequest(message: string, traceId: string): HttpException {
  return new HttpException({ code: 'validation.failed', message, traceId }, 400);
}

/** 404 envelope for a message or template missing in the tenant. */
function notFound(entity: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'not_found', message: `${entity} not found`, traceId },
    404,
  );
}

/** 409 envelope for a duplicate template version or a bad transition. */
function conflict(code: string, message: string, traceId: string): HttpException {
  return new HttpException({ code, message, traceId }, 409);
}

// ============ request → actor ============

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

/**
 * Builds the actor context from the request the tenant middleware already
 * bound (`tenant` + `tenantClient`). API-key callers land here exactly like
 * JWT callers, so only a human tenant admin membership passes the gate below.
 */
export function actorFromNotifyRequest(req: NotifyRequest): NotifyActor {
  const tenant = req.tenant;
  const client = req.tenantClient;
  if (tenant === undefined || client === undefined) {
    throw new HttpException(
      {
        code: 'tenant.missing',
        message: 'Request has no tenant context',
        traceId: readHeader(req.headers, 'x-trace-id') ?? 'unknown',
      },
      403,
    );
  }
  const traceId = readHeader(req.headers, 'x-trace-id') ?? 'unknown';
  const forwarded = readHeader(req.headers, 'x-forwarded-for');
  return {
    client,
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    traceId,
    ip: forwarded === undefined ? null : (forwarded.split(',')[0]?.trim() ?? null),
  };
}

// ============ row mapping ============

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function readNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readInteger(value: unknown, fallback = 0): number {
  return Math.trunc(readNumber(value, fallback));
}

/** `pg` hands timestamptz back as `Date`; normalize to ISO, keep nulls. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Maps a raw `message_log` row onto the wire shape (`recipient` → `to`). */
export function mapMessageRow(row: Record<string, unknown>): NotifyMessageRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    channel: readString(row.channel) ?? '',
    template: readString(row.template) ?? '',
    to: readString(row.recipient) ?? '',
    status: readString(row.status) ?? '',
    cost: readNumber(row.cost),
    providerRef: readString(row.provider_ref) ?? null,
    createdAt: toIso(row.at),
  };
}

/** Maps a raw `notify_templates` row onto the wire shape. */
export function mapTemplateRow(row: Record<string, unknown>): NotifyTemplateRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    channel: readString(row.channel) ?? '',
    code: readString(row.code) ?? '',
    version: readInteger(row.version, 1),
    body: readString(row.body) ?? '',
    status: readString(row.status) ?? '',
  };
}

// ============ SQL ============

const SELECT_SUBTREE_SQL = `WITH RECURSIVE subtree AS (
  SELECT id FROM org_nodes WHERE tenant_id = $1 AND id = $2
  UNION ALL
  SELECT n.id FROM org_nodes n
  JOIN subtree s ON n.parent_id = s.id
  WHERE n.tenant_id = $1
)
SELECT id FROM subtree`;

const SELECT_ACTIVE_TEMPLATE_SQL = `SELECT id, tenant_id, channel, code, version, body, status
FROM notify_templates
WHERE tenant_id = $1 AND channel = $2 AND code = $3 AND status = 'active'
ORDER BY version DESC LIMIT 1`;

const INSERT_MESSAGE_SQL = `INSERT INTO message_log
  (tenant_id, channel, template, recipient, status, cost)
VALUES ($1, $2, $3, $4, 'queued', 0)
RETURNING id, tenant_id, channel, template, recipient, status, cost, provider_ref, at`;

const SELECT_MESSAGE_SQL = `SELECT id, tenant_id, channel, template, recipient, status, cost, provider_ref, at
FROM message_log WHERE tenant_id = $1 AND id = $2`;

const INSERT_TEMPLATE_SQL = `INSERT INTO notify_templates
  (tenant_id, channel, code, version, body, status)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, tenant_id, channel, code, version, body, status`;

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

// ============ guard facts ============

/** Loads the membership and, when present, the subtree under its node. */
async function loadFacts(
  actor: NotifyActor,
): Promise<{ membership: MembershipRecord | null; scopeSubtree: string[] }> {
  const membership = await loadMembership(actor.client, actor.userId, actor.tenantId);
  if (membership === null) return { membership, scopeSubtree: [] };
  const result = await actor.client.query(SELECT_SUBTREE_SQL, [actor.tenantId, membership.orgNodeId]);
  const scopeSubtree: string[] = [];
  for (const row of readRows(result)) {
    if (typeof row.id === 'string') scopeSubtree.push(row.id);
  }
  return { membership, scopeSubtree };
}

/**
 * The management gate: only an active, in-window tenant admin membership
 * passes. Runs the central rule so every denial is audited as `access.denied`
 * with the caller-visible reason. There is no tenant-module gate for notify
 * management (`moduleActive: true`): notifications serve the tenant itself,
 * not one vertical — same rationale as API keys and webhooks.
 */
async function authorizeAdmin(
  actor: NotifyActor,
  membership: MembershipRecord | null,
  scopeSubtree: readonly string[],
  attemptedAction: string,
): Promise<MembershipRecord> {
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: [], scope: [] },
    membership,
    entityOrgNodeId: membership?.orgNodeId ?? actor.tenantId,
    scopeSubtree: [...scopeSubtree],
    rolePermits: membership !== null && isNotifyAdminRole(membership.role),
    stateAllows: true,
    moduleActive: true,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'notify_message',
      entityId: null,
      orgNodeId: membership?.orgNodeId ?? null,
      attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return membership as MembershipRecord;
}

/** Appends one row per successful management write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: NotifyActor,
  membership: MembershipRecord,
  action: string,
  entity: string,
  entityId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    action,
    entity,
    entityId,
    membership.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...diff }),
    actor.ip,
  ]);
}

// ============ input validation ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseChannel(value: unknown, traceId: string): string {
  if (typeof value !== 'string' || !(NOTIFY_CHANNELS as readonly string[]).includes(value)) {
    throw badRequest(`channel must be one of ${(NOTIFY_CHANNELS as readonly string[]).join(', ')}`, traceId);
  }
  return value;
}

function parseTemplateCode(value: unknown, traceId: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('template is required', traceId);
  }
  const code = value.trim();
  if (code.length > MAX_TEMPLATE_LENGTH) {
    throw badRequest(`template must be at most ${MAX_TEMPLATE_LENGTH} characters`, traceId);
  }
  return code;
}

function parseRecipientTo(value: unknown, traceId: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('to is required', traceId);
  }
  const to = value.trim();
  if (to.length > MAX_TO_LENGTH) {
    throw badRequest(`to must be at most ${MAX_TO_LENGTH} characters`, traceId);
  }
  return to;
}

function parsePayload(value: unknown, traceId: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('payload must be a JSON object', traceId);
  }
  return value as Record<string, unknown>;
}

/** Validates the enqueue/send body; mirrors `notifySendInputSchema` (contracts). */
export function parseNotifyEnqueueInput(body: unknown, traceId: string): NotifyEnqueueInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with channel, template and to', traceId);
  }
  const record = body as Record<string, unknown>;
  return {
    channel: parseChannel(record.channel, traceId),
    template: parseTemplateCode(record.template, traceId),
    to: parseRecipientTo(record.to, traceId),
    payload: parsePayload(record.payload, traceId),
  };
}

/**
 * Parses the query of `GET /v1/notify/messages`. Every filter is optional;
 * an unknown channel or status is a 400, never a silently ignored filter.
 */
export function parseMessageFilters(query: unknown, traceId: string): NotifyMessageFilters {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const readOptional = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const channel = readOptional(record.channel);
  if (channel !== null && !(NOTIFY_CHANNELS as readonly string[]).includes(channel)) {
    throw badRequest(`Invalid channel: ${channel}`, traceId);
  }
  const status = readOptional(record.status);
  if (status !== null && !(NOTIFY_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`Invalid status: ${status}`, traceId);
  }
  return { channel, status };
}

/** Validates the template body; mirrors `notifyTemplateCreateInputSchema` (contracts). */
export function parseNotifyTemplateCreateInput(body: unknown, traceId: string): NotifyTemplateCreateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with channel, code and body', traceId);
  }
  const record = body as Record<string, unknown>;
  if (typeof record.body !== 'string' || record.body.trim() === '') {
    throw badRequest('body is required', traceId);
  }
  const text = record.body.trim();
  if (text.length > MAX_BODY_LENGTH) {
    throw badRequest(`body must be at most ${MAX_BODY_LENGTH} characters`, traceId);
  }
  const version = record.version === undefined ? 1 : record.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw badRequest('version must be an integer >= 1', traceId);
  }
  const status = record.status === undefined ? 'draft' : record.status;
  if (typeof status !== 'string' || !(NOTIFY_TEMPLATE_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(
      `status must be one of ${(NOTIFY_TEMPLATE_STATUSES as readonly string[]).join(', ')}`,
      traceId,
    );
  }
  return {
    channel: parseChannel(record.channel, traceId),
    code: parseTemplateCode(record.code, traceId),
    body: text,
    version,
    status,
  };
}

/**
 * Parses the query of `GET /v1/notify/templates`. No filter lists the active
 * templates; an explicit `status` widens the read to that lifecycle state.
 */
export function parseTemplateFilters(query: unknown, traceId: string): NotifyTemplateFilters {
  const record =
    typeof query === 'object' && query !== null && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const raw = record.status;
  if (raw === undefined || raw === null) return { status: 'active' };
  if (typeof raw !== 'string' || raw.trim() === '') return { status: 'active' };
  const status = raw.trim();
  if (!(NOTIFY_TEMPLATE_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(`Invalid status: ${status}`, traceId);
  }
  return { status };
}

function requireUuidParam(value: string, label: string, traceId: string): string {
  const trimmed = value?.trim() ?? '';
  if (!UUID_RE.test(trimmed)) {
    throw badRequest(`Invalid ${label}`, traceId);
  }
  return trimmed;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// ============ template reads ============

/**
 * Returns the newest `active` template version for one `(channel, code)` pair,
 * or null when the tenant has none. Reads write no audit row (§4.4).
 */
export async function getActiveTemplate(
  client: NotifyClient,
  tenantId: string,
  channel: string,
  code: string,
): Promise<NotifyTemplateRecord | null> {
  const result = await client.query(SELECT_ACTIVE_TEMPLATE_SQL, [tenantId, channel, code]);
  const row = readRows(result)[0];
  return row === undefined ? null : mapTemplateRow(row);
}

// ============ same-tx enqueue writer ============

/**
 * Enqueues one notification in the emitter's transaction (same `client`, no
 * BEGIN/COMMIT): the `queued` row commits or rolls back atomically with the
 * business write. Fails fast with `notify.template_missing` (400) when no
 * `active` template exists for the `(channel, code)` pair.
 *
 * Contract → SQL mapping: `input.to` is stored in the `recipient` column.
 * No guard runs here on purpose: the emitter already authorized the business
 * action, and the row stays within the same tenant.
 */
export async function enqueueNotify(
  client: NotifyClient,
  tenantId: string,
  input: NotifyEnqueueInput,
): Promise<NotifyMessageRecord> {
  const channel = parseChannel(input.channel, 'unknown');
  const template = parseTemplateCode(input.template, 'unknown');
  const to = parseRecipientTo(input.to, 'unknown');
  const payload = input.payload ?? {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw badRequest('payload must be a JSON object', 'unknown');
  }
  const active = await getActiveTemplate(client, tenantId, channel, template);
  if (active === null) {
    throw new HttpException(
      {
        code: 'notify.template_missing',
        message: `No active template '${template}' for channel '${channel}'`,
        traceId: 'unknown',
      },
      400,
    );
  }
  const result = await client.query(INSERT_MESSAGE_SQL, [tenantId, channel, template, to]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      { code: 'notify.enqueue_failed', message: 'Could not enqueue the notification', traceId: 'unknown' },
      500,
    );
  }
  return mapMessageRow(row);
}

// ============ worker-owned status transitions ============

/**
 * Moves one message to a new status. Only the documented edges are allowed:
 * `queued → sent`, `sent → delivered`, `queued|sent → failed`. An unknown id
 * answers 404; a row on any other edge answers 409. Writes no audit row: the
 * worker owns the delivery lifecycle, so the API never moves a message.
 */
async function transitionMessage(
  client: NotifyClient,
  tenantId: string,
  id: string,
  from: readonly string[],
  next: string,
  mark: NotifyMarkInput,
  traceId: string,
): Promise<NotifyMessageRecord> {
  const messageId = requireUuidParam(id, 'message id', traceId);
  const cost = mark.cost === undefined ? null : mark.cost;
  if (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
    throw badRequest('cost must be a non-negative number', traceId);
  }
  const providerRef = mark.providerRef === undefined ? null : mark.providerRef?.trim() || null;
  const placeholders = from.map((_, index) => `$${index + 4}`).join(', ');
  const updated = await client.query(
    `UPDATE message_log SET status = $3, cost = COALESCE($5, cost), provider_ref = COALESCE($6, provider_ref) ` +
      `WHERE id = $1 AND tenant_id = $2 AND status IN (${placeholders}) ` +
      `RETURNING id, tenant_id, channel, template, recipient, status, cost, provider_ref, at`,
    [messageId, tenantId, next, ...from, cost, providerRef],
  );
  const row = readRows(updated)[0];
  if (row !== undefined) return mapMessageRow(row);
  const current = await client.query(SELECT_MESSAGE_SQL, [tenantId, messageId]);
  if (readRows(current)[0] === undefined) throw notFound('Notify message', traceId);
  throw conflict(
    'notify.bad_transition',
    `Cannot move the message to '${next}' from its current status`,
    traceId,
  );
}

/**
 * Best-effort variant of `enqueueNotify` for business emitters (billing,
 * salud): joins the emitter transaction like `enqueueNotify`, but never
 * throws — a missing `active` template, a blank recipient or any other
 * enqueue failure resolves to `null` so the business write always commits.
 *
 * Caveat: only pre-write failures are truly free. The template lookup runs
 * before the insert, so the documented skip paths never touch a SQL write;
 * an unexpected insert failure still surfaces at COMMIT time (Postgres
 * aborts the transaction on any failed statement). Operational visibility
 * for skipped notifications comes from the `message_log` gap and from the
 * direct `POST /v1/notify/send` path, which keeps failing fast.
 */
export async function tryEnqueueNotify(
  client: NotifyClient,
  tenantId: string,
  input: NotifyEnqueueInput,
): Promise<NotifyMessageRecord | null> {
  try {
    return await enqueueNotify(client, tenantId, input);
  } catch {
    return null;
  }
}

/** `queued → sent`: the provider accepted the notification for delivery. */
export function markSent(
  client: NotifyClient,
  tenantId: string,
  id: string,
  mark: NotifyMarkInput = {},
  traceId = 'unknown',
): Promise<NotifyMessageRecord> {
  return transitionMessage(client, tenantId, id, ['queued'], 'sent', mark, traceId);
}

/** `sent → delivered`: the provider confirmed the delivery. */
export function markDelivered(
  client: NotifyClient,
  tenantId: string,
  id: string,
  mark: NotifyMarkInput = {},
  traceId = 'unknown',
): Promise<NotifyMessageRecord> {
  return transitionMessage(client, tenantId, id, ['sent'], 'delivered', mark, traceId);
}

/** `queued|sent → failed`: the provider reported a terminal failure. */
export function markFailed(
  client: NotifyClient,
  tenantId: string,
  id: string,
  mark: NotifyMarkInput = {},
  traceId = 'unknown',
): Promise<NotifyMessageRecord> {
  return transitionMessage(client, tenantId, id, ['queued', 'sent'], 'failed', mark, traceId);
}

// ============ management use cases ============

/**
 * `POST /v1/notify/send` — enqueues one notification directly for the caller
 * tenant, behind the tenant-admin gate, with one `audit_log` row.
 */
export async function sendNotification(
  actor: NotifyActor,
  body: unknown,
): Promise<NotifyMessageRecord> {
  const input = parseNotifyEnqueueInput(body, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'notify_message.send');
  const active = await getActiveTemplate(actor.client, actor.tenantId, input.channel, input.template);
  if (active === null) {
    throw new HttpException(
      {
        code: 'notify.template_missing',
        message: `No active template '${input.template}' for channel '${input.channel}'`,
        traceId: actor.traceId,
      },
      400,
    );
  }
  const result = await actor.client.query(INSERT_MESSAGE_SQL, [
    actor.tenantId,
    input.channel,
    input.template,
    input.to,
  ]);
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      {
        code: 'notify.enqueue_failed',
        message: 'Could not enqueue the notification',
        traceId: actor.traceId,
      },
      500,
    );
  }
  const record = mapMessageRow(row);
  await writeAudit(actor, admin, 'notify_message.sent', 'notify_message', record.id, {
    channel: record.channel,
    template: record.template,
  });
  return record;
}

/**
 * `GET /v1/notify/messages` — messages inside the tenant, newest first,
 * capped at 200 rows. Reads write no audit row (§4.4).
 */
export async function listMessages(
  actor: NotifyActor,
  query: unknown,
): Promise<NotifyMessageRecord[]> {
  const filters = parseMessageFilters(query, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  await authorizeAdmin(actor, membership, scopeSubtree, 'notify_message.list');
  const conditions = ['tenant_id = $1'];
  const values: unknown[] = [actor.tenantId];
  if (filters.channel !== null) {
    values.push(filters.channel);
    conditions.push(`channel = $${values.length}`);
  }
  if (filters.status !== null) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await actor.client.query(
    `SELECT id, tenant_id, channel, template, recipient, status, cost, provider_ref, at ` +
      `FROM message_log WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY at DESC LIMIT ${NOTIFY_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapMessageRow);
}

/**
 * `GET /v1/notify/templates` — active templates by default, newest version
 * first; an explicit `?status=` widens the read. Reads write no audit row.
 */
export async function listTemplates(
  actor: NotifyActor,
  query: unknown,
): Promise<NotifyTemplateRecord[]> {
  const filters = parseTemplateFilters(query, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  await authorizeAdmin(actor, membership, scopeSubtree, 'notify_template.list');
  const conditions = ['tenant_id = $1'];
  const values: unknown[] = [actor.tenantId];
  if (filters.status !== null) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  const result = await actor.client.query(
    `SELECT id, tenant_id, channel, code, version, body, status FROM notify_templates ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY channel ASC, code ASC, version DESC LIMIT ${NOTIFY_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapTemplateRow);
}

/**
 * `POST /v1/notify/templates` — registers one template version. A duplicate
 * `(channel, code, version)` answers 409: bump the version instead.
 */
export async function createTemplate(
  actor: NotifyActor,
  body: unknown,
): Promise<NotifyTemplateRecord> {
  const input = parseNotifyTemplateCreateInput(body, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'notify_template.create');
  let result: unknown;
  try {
    result = await actor.client.query(INSERT_TEMPLATE_SQL, [
      actor.tenantId,
      input.channel,
      input.code,
      input.version,
      input.body,
      input.status,
    ]);
  } catch (error) {
    if (sqlState(error) === '23505') {
      throw conflict(
        'notify.template_exists',
        `Template '${input.code}' already has version ${input.version} on channel '${input.channel}'`,
        actor.traceId,
      );
    }
    throw error;
  }
  const row = readRows(result)[0];
  if (row === undefined) {
    throw new HttpException(
      {
        code: 'notify.template_create_failed',
        message: 'Could not create the notify template',
        traceId: actor.traceId,
      },
      500,
    );
  }
  const record = mapTemplateRow(row);
  await writeAudit(actor, admin, 'notify_template.created', 'notify_template', record.id, {
    channel: record.channel,
    code: record.code,
    version: record.version,
  });
  return record;
}
