// Tenant webhook subscriptions + outbox writer (W2, extended in W3).
//
// Deliberately plain: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`) and the controller stays thin. The
// service owns the management use case end to end:
//   1. build the actor from the request the tenant middleware already bound;
//   2. load the membership + org subtree and run the central rule through
//      `canActivate` — which audits every denial as `access.denied`;
//   3. run the tenant-scoped SQL (RLS already bound the transaction) and, for
//      every write, append one `audit_log` row.
//
// Security contract (same shape as W1 api keys):
// - The signing secret is generated with 256-bit entropy, shown EXACTLY once
//   (the create/rotate response) and stored only as a SHA-256 hex digest
//   (`secret_hash`). The worker signs the exact payload bytes with
//   HMAC-SHA256; the clear secret never touches disk.
// - Management (create/list/update/remove/rotate) requires a tenant admin
//   membership: `ti_admin` (tenant operator) or `direccion` (tenant
//   management). Any other role — including service callers authenticated by
//   API key — is denied with `role.denied` and the denial is audited.
// - Deliveries are read-only from the API (`GET /deliveries`): the worker owns
//   the `queued → sent|failed` transitions, so the API never moves a delivery.
//
// Outbox contract:
// - `enqueueWebhooks` runs INSIDE the business transaction of the emitter
//   (same `client`, no BEGIN/COMMIT here): the delivery rows commit or roll
//   back atomically with the business write. It selects the active
//   subscriptions matching the event and inserts one `queued` delivery per
//   subscription, denormalizing the URL frozen at enqueue time.
// - Piggyback points (each file outside this task's surface owns its call):
//   `billing.service.ts` calls `enqueueInvoiceWebhooks` after the
//   `invoice.issued` audit in `issueInvoice`, after the `invoice.paid` audit
//   in `payInvoice`, and after the `invoice.voided` audit in `voidInvoice`;
//   `obras/resources.service.ts` calls `enqueueWebhooks` with `stock.posted`
//   after the `stock_move.posted` audit in `postStockMove` and with
//   `stock.reversed` after the `stock_move.reversed` audit in `reverseMove`;
//   the tenant provisioning that persists the acta calls
//   `enqueueOnboardingClosed` with `onboarding.closed` in its own business
//   transaction (the wizard close in `onboarding/store.ts` is pre-tenant, so
//   it cannot fan out: `webhook_deliveries.tenant_id` is NOT NULL).
import { HttpException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { canActivate, loadMembership, type MembershipRecord } from '../auth/access.guard.ts';

/** Business events the outbox writer emits (W2 billing, W3 stock + onboarding). */
export const WEBHOOK_BILLING_EVENTS = ['invoice.issued', 'invoice.paid', 'invoice.voided'] as const;

/** Warehouse stock events (W3): fanned out by `obras/resources.service.ts`. */
export const WEBHOOK_STOCK_EVENTS = ['stock.posted', 'stock.reversed'] as const;

/** Onboarding events (W3): fanned out once a tenant exists (see below). */
export const WEBHOOK_ONBOARDING_EVENTS = ['onboarding.closed'] as const;

/** Every event a subscription may register for (validation + filters). */
export const WEBHOOK_EVENTS = [
  ...WEBHOOK_BILLING_EVENTS,
  ...WEBHOOK_STOCK_EVENTS,
  ...WEBHOOK_ONBOARDING_EVENTS,
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export type InvoiceWebhookEvent = (typeof WEBHOOK_BILLING_EVENTS)[number];

/** Roles allowed to manage subscriptions (same custodians as API keys). */
export const WEBHOOK_ADMIN_ROLES = ['ti_admin', 'direccion'] as const;

/** Rows a list endpoint returns at most; keeps a stray wide scan bounded. */
export const WEBHOOK_LIST_LIMIT = 200;

/** Entropy of one signing secret (256-bit, base64url-encoded on the wire). */
const SECRET_RANDOM_BYTES = 32;

/** Public wire prefix of an issued secret (identification only). */
const SECRET_PREFIX = 'whsec_';

/** Longest URL the service stores (mirrors the contract `max(2000)`). */
const MAX_URL_LENGTH = 2000;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface WebhookClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Framework-free request shape the controller forwards (structural). */
export interface WebhookRequest {
  headers?: Record<string, string | string[] | undefined>;
  tenant?: { tenantId: string; userId: string; scopes: readonly string[] };
  tenantClient?: WebhookClient;
}

/** Everything a use case needs from the request, framework-free. */
export interface WebhookActor {
  readonly client: WebhookClient;
  readonly tenantId: string;
  readonly userId: string;
  readonly traceId: string;
  readonly ip: string | null;
}

/** One subscription as the list endpoint returns it — never the secret. */
export interface WebhookSubscriptionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly createdAt: string | null;
}

/** Create/rotate answer: the record plus the secret, shown exactly once. */
export interface WebhookSubscriptionCreated extends WebhookSubscriptionRecord {
  readonly secret: string;
}

/** One delivery as the read-only management endpoint returns it. */
export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly subscriptionId: string | null;
  readonly event: string;
  readonly url: string;
  readonly status: string;
  readonly attempts: number;
  readonly nextRetryAt: string | null;
  readonly createdAt: string | null;
}

/** Validated `POST /v1/webhooks/subscriptions` body. */
export interface WebhookSubscriptionCreateInput {
  readonly url: string;
  readonly events: readonly string[];
}

/** Validated `PATCH /v1/webhooks/subscriptions/:id` body. */
export interface WebhookSubscriptionUpdateInput {
  readonly url: string | undefined;
  readonly events: readonly string[] | undefined;
  readonly active: boolean | undefined;
}

/** Filters of `GET /v1/webhooks/deliveries` — every filter is optional. */
export interface WebhookDeliveryFilters {
  readonly subscriptionId: string | null;
  readonly status: string | null;
  readonly event: string | null;
}

/** Input of the outbox writer: one business fact fanned out to subscribers. */
export interface WebhookEnqueueInput {
  readonly event: WebhookEventName;
  /** Business entity id (invoice, stock move, onboarding case) as `event_id`. */
  readonly eventId: string;
  /** Exact payload the worker signs and POSTs (must be JSON-serializable). */
  readonly payload: Record<string, unknown>;
}

/** Input of the outbox writer: one business fact fanned out to subscribers. */
export interface InvoiceWebhookInput {
  readonly event: InvoiceWebhookEvent;
  /** Business entity id (the invoice id) stored as `event_id` for correlation. */
  readonly invoiceId: string;
  /** Exact payload the worker signs and POSTs (must be JSON-serializable). */
  readonly payload: Record<string, unknown>;
}

/** Input of the `onboarding.closed` fan-out (tenant provisioning site). */
export interface OnboardingClosedWebhookInput {
  /** Closed `onboarding_cases` id, stored as `event_id` for correlation. */
  readonly caseId: string;
  /** Replay key of the closed run, echoed so receivers can dedupe. */
  readonly idempotencyKey: string;
  /** Signed acta hash (`sha256Hex` of the `advance` payload). */
  readonly actaHash: string;
}

// ============ secret handling ============

/** SHA-256 hex digest of a signing secret; the only form ever stored. */
export function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Issues one opaque signing secret (`whsec_` + 256-bit base64url) with its
 * digest. The receiver uses the secret to verify the HMAC-SHA256 signature.
 */
export function generateWebhookSecret(): { secret: string; secretHash: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(SECRET_RANDOM_BYTES).toString('base64url')}`;
  return { secret, secretHash: hashWebhookSecret(secret) };
}

/** True for the two tenant admin roles that may manage subscriptions. */
export function isWebhookAdminRole(role: string): boolean {
  return (WEBHOOK_ADMIN_ROLES as readonly string[]).includes(role);
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

/** 404 envelope for a subscription or delivery missing in the tenant. */
function notFound(entity: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'not_found', message: `${entity} not found`, traceId },
    404,
  );
}

/** 409 envelope when a subscription with deliveries is removed. */
function conflict(message: string, traceId: string): HttpException {
  return new HttpException(
    { code: 'webhook.subscription_in_use', message, traceId },
    409,
  );
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
export function actorFromWebhookRequest(req: WebhookRequest): WebhookActor {
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: string[] = [];
  for (const item of value) {
    const text = readString(item);
    if (text !== undefined) entries.push(text);
  }
  return entries;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't';
}

function readNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** `pg` hands timestamptz back as `Date`; normalize to ISO, keep nulls. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** Maps a raw `webhook_subscriptions` row (no secret, no hash). */
export function mapSubscriptionRow(row: Record<string, unknown>): WebhookSubscriptionRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    url: readString(row.url) ?? '',
    events: readStringArray(row.events),
    active: readBoolean(row.active),
    createdAt: toIso(row.created_at),
  };
}

/** Maps a raw `webhook_deliveries` row onto the observable retry shape. */
export function mapDeliveryRow(row: Record<string, unknown>): WebhookDeliveryRecord {
  return {
    id: readString(row.id) ?? '',
    tenantId: readString(row.tenant_id) ?? '',
    subscriptionId: readString(row.subscription_id) ?? null,
    event: readString(row.event) ?? '',
    url: readString(row.url) ?? '',
    status: readString(row.status) ?? '',
    attempts: readNumber(row.attempts),
    nextRetryAt: toIso(row.next_retry_at),
    createdAt: toIso(row.created_at),
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

const INSERT_SUBSCRIPTION_SQL = `INSERT INTO webhook_subscriptions
  (tenant_id, url, secret_hash, events, active)
VALUES ($1, $2, $3, $4, TRUE)
RETURNING id, tenant_id, url, events, active, created_at`;

const SELECT_SUBSCRIPTIONS_SQL = `SELECT id, tenant_id, url, events, active, created_at
FROM webhook_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT ${WEBHOOK_LIST_LIMIT}`;

const UPDATE_SUBSCRIPTION_SQL = `UPDATE webhook_subscriptions
SET url = COALESCE($3, url),
    events = COALESCE($4, events),
    active = COALESCE($5, active)
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, url, events, active, created_at`;

const DELETE_SUBSCRIPTION_SQL = `DELETE FROM webhook_subscriptions
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, url, events, active, created_at`;

const ROTATE_SUBSCRIPTION_SQL = `UPDATE webhook_subscriptions
SET secret_hash = $3
WHERE id = $1 AND tenant_id = $2
RETURNING id, tenant_id, url, events, active, created_at`;

const SELECT_ACTIVE_SUBSCRIPTIONS_SQL = `SELECT id, url
FROM webhook_subscriptions
WHERE tenant_id = $1 AND active AND $2 = ANY(events)`;

const INSERT_DELIVERY_SQL = `INSERT INTO webhook_deliveries
  (tenant_id, subscription_id, event_id, url, event, payload, status, attempts, next_retry_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'queued', 0, NULL)
RETURNING id, tenant_id, subscription_id, event, url, status, attempts, next_retry_at, created_at`;

const SELECT_DELIVERY_SQL = `SELECT id, tenant_id, subscription_id, event, url, status, attempts, next_retry_at, created_at
FROM webhook_deliveries WHERE tenant_id = $1 AND id = $2`;

const INSERT_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

// ============ guard facts ============

/** Loads the membership and, when present, the subtree under its node. */
async function loadFacts(
  actor: WebhookActor,
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
 * with the caller-visible reason. There is no tenant-module gate for webhook
 * management (`moduleActive: true`): subscriptions serve the tenant itself,
 * not one vertical — same rationale as API keys.
 */
async function authorizeAdmin(
  actor: WebhookActor,
  membership: MembershipRecord | null,
  scopeSubtree: readonly string[],
  attemptedAction: string,
): Promise<MembershipRecord> {
  const decision = await canActivate({
    identity: { sub: actor.userId, tenantId: actor.tenantId, roles: [], scope: [] },
    membership,
    entityOrgNodeId: membership?.orgNodeId ?? actor.tenantId,
    scopeSubtree: [...scopeSubtree],
    rolePermits: membership !== null && isWebhookAdminRole(membership.role),
    stateAllows: true,
    moduleActive: true,
    audit: {
      client: actor.client,
      traceId: actor.traceId,
      entity: 'webhook_subscription',
      entityId: null,
      orgNodeId: membership?.orgNodeId ?? null,
      attemptedAction,
      ip: actor.ip,
    },
  });
  if (!decision.allow) throw accessDenied(decision.reason, actor.traceId);
  return membership as MembershipRecord;
}

/** Appends one row per successful subscription write (§4.4); the trace id rides in `diff`. */
async function writeAudit(
  actor: WebhookActor,
  membership: MembershipRecord,
  action: string,
  subscriptionId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await actor.client.query(INSERT_AUDIT_SQL, [
    membership.tenantId,
    actor.userId,
    action,
    'webhook_subscription',
    subscriptionId,
    membership.orgNodeId,
    JSON.stringify({ traceId: actor.traceId, ...diff }),
    actor.ip,
  ]);
}

// ============ input validation ============

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_STATUSES = ['queued', 'sent', 'failed'] as const;

function parseSubscriptionUrl(value: unknown, traceId: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('url is required', traceId);
  }
  const url = value.trim();
  if (url.length > MAX_URL_LENGTH) {
    throw badRequest(`url must be at most ${MAX_URL_LENGTH} characters`, traceId);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest('url must be a valid absolute URL', traceId);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw badRequest('url must use the http or https scheme', traceId);
  }
  return url;
}

function parseSubscriptionEvents(value: unknown, traceId: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest('events must be a non-empty array of event names', traceId);
  }
  const events: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(entry)) {
      throw badRequest(`event is invalid: ${String(entry)}`, traceId);
    }
    if (!events.includes(entry)) events.push(entry);
  }
  return events;
}

/** Validates the create body; mirrors `webhookSubscriptionCreateInputSchema` (contracts). */
export function parseSubscriptionCreateInput(body: unknown, traceId: string): WebhookSubscriptionCreateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with url and events', traceId);
  }
  const record = body as Record<string, unknown>;
  return {
    url: parseSubscriptionUrl(record.url, traceId),
    events: parseSubscriptionEvents(record.events, traceId),
  };
}

/** Validates the update body; mirrors `webhookSubscriptionUpdateInputSchema` (contracts). */
export function parseSubscriptionUpdateInput(body: unknown, traceId: string): WebhookSubscriptionUpdateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object with url, events or active', traceId);
  }
  const record = body as Record<string, unknown>;
  const hasUrl = record.url !== undefined;
  const hasEvents = record.events !== undefined;
  const hasActive = record.active !== undefined;
  if (!hasUrl && !hasEvents && !hasActive) {
    throw badRequest('Body must include at least one of url, events or active', traceId);
  }
  if (hasActive && typeof record.active !== 'boolean') {
    throw badRequest('active must be a boolean', traceId);
  }
  return {
    url: hasUrl ? parseSubscriptionUrl(record.url, traceId) : undefined,
    events: hasEvents ? parseSubscriptionEvents(record.events, traceId) : undefined,
    active: hasActive ? (record.active as boolean) : undefined,
  };
}

/**
 * Parses the query of `GET /v1/webhooks/deliveries`. Every filter is optional;
 * a malformed UUID, an unknown status or an unknown event is a 400, never a
 * silently ignored filter.
 */
export function parseDeliveryFilters(query: unknown, traceId: string): WebhookDeliveryFilters {
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
  const rawSubscription = readOptional(record.subscriptionId ?? record.subscription);
  if (rawSubscription !== null && !UUID_RE.test(rawSubscription)) {
    throw badRequest('Invalid subscriptionId: expected a UUID', traceId);
  }
  const rawStatus = readOptional(record.status);
  if (rawStatus !== null && !(DELIVERY_STATUSES as readonly string[]).includes(rawStatus)) {
    throw badRequest(`Invalid status: ${rawStatus}`, traceId);
  }
  const rawEvent = readOptional(record.event);
  if (rawEvent !== null && !(WEBHOOK_EVENTS as readonly string[]).includes(rawEvent)) {
    throw badRequest(`Invalid event: ${rawEvent}`, traceId);
  }
  return { subscriptionId: rawSubscription, status: rawStatus, event: rawEvent };
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

// ============ management use cases ============

/**
 * `POST /v1/webhooks/subscriptions` — registers one subscription. Returns the
 * record plus the signing secret; the secret is shown here exactly once.
 */
export async function createSubscription(
  actor: WebhookActor,
  body: unknown,
): Promise<WebhookSubscriptionCreated> {
  const input = parseSubscriptionCreateInput(body, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_subscription.create');

  const { secret, secretHash } = generateWebhookSecret();
  const result = await actor.client.query(INSERT_SUBSCRIPTION_SQL, [
    actor.tenantId,
    input.url,
    secretHash,
    input.events,
  ]);
  const rows = readRows(result);
  if (rows.length === 0) {
    throw new HttpException(
      {
        code: 'webhook.create_failed',
        message: 'Could not create the webhook subscription',
        traceId: actor.traceId,
      },
      500,
    );
  }
  const record = mapSubscriptionRow(rows[0]);
  await writeAudit(actor, admin, 'webhook_subscription.created', record.id, {
    url: record.url,
    events: [...record.events],
  });
  return { ...record, secret };
}

/** `GET /v1/webhooks/subscriptions` — lists the tenant subscriptions, newest first. */
export async function listSubscriptions(actor: WebhookActor): Promise<WebhookSubscriptionRecord[]> {
  const { membership, scopeSubtree } = await loadFacts(actor);
  await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_subscription.list');
  const result = await actor.client.query(SELECT_SUBSCRIPTIONS_SQL, [actor.tenantId]);
  return readRows(result).map(mapSubscriptionRow);
}

/**
 * `PATCH /v1/webhooks/subscriptions/:id` — edits the URL, the event set or
 * the active flag. Unknown ids answer 404.
 */
export async function updateSubscription(
  actor: WebhookActor,
  id: string,
  body: unknown,
): Promise<WebhookSubscriptionRecord> {
  const subscriptionId = requireUuidParam(id, 'subscription id', actor.traceId);
  const input = parseSubscriptionUpdateInput(body, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_subscription.update');
  const result = await actor.client.query(UPDATE_SUBSCRIPTION_SQL, [
    subscriptionId,
    actor.tenantId,
    input.url ?? null,
    input.events ?? null,
    input.active ?? null,
  ]);
  const rows = readRows(result);
  if (rows.length === 0) throw notFound('Webhook subscription', actor.traceId);
  const record = mapSubscriptionRow(rows[0]);
  await writeAudit(actor, admin, 'webhook_subscription.updated', record.id, {
    url: record.url,
    events: [...record.events],
    active: record.active,
  });
  return record;
}

/**
 * `DELETE /v1/webhooks/subscriptions/:id` — removes one subscription.
 * A subscription with delivery history cannot be removed (409): deactivate it
 * instead so the history stays queryable.
 */
export async function removeSubscription(actor: WebhookActor, id: string): Promise<WebhookSubscriptionRecord> {
  const subscriptionId = requireUuidParam(id, 'subscription id', actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_subscription.remove');
  let result: unknown;
  try {
    result = await actor.client.query(DELETE_SUBSCRIPTION_SQL, [subscriptionId, actor.tenantId]);
  } catch (error) {
    if (sqlState(error) === '23503') {
      throw conflict(
        'The subscription has delivery history; deactivate it instead of removing it',
        actor.traceId,
      );
    }
    throw error;
  }
  const rows = readRows(result);
  if (rows.length === 0) throw notFound('Webhook subscription', actor.traceId);
  const record = mapSubscriptionRow(rows[0]);
  await writeAudit(actor, admin, 'webhook_subscription.removed', record.id, { url: record.url });
  return record;
}

/**
 * `POST /v1/webhooks/subscriptions/:id/rotate` — replaces the signing secret.
 * Returns the record plus the new secret, shown exactly once; deliveries
 * already queued keep the bytes they were enqueued with.
 */
export async function rotateSubscriptionSecret(
  actor: WebhookActor,
  id: string,
): Promise<WebhookSubscriptionCreated> {
  const subscriptionId = requireUuidParam(id, 'subscription id', actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  const admin = await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_subscription.rotate');
  const { secret, secretHash } = generateWebhookSecret();
  const result = await actor.client.query(ROTATE_SUBSCRIPTION_SQL, [
    subscriptionId,
    actor.tenantId,
    secretHash,
  ]);
  const rows = readRows(result);
  if (rows.length === 0) throw notFound('Webhook subscription', actor.traceId);
  const record = mapSubscriptionRow(rows[0]);
  await writeAudit(actor, admin, 'webhook_subscription.rotated', record.id, { url: record.url });
  return { ...record, secret };
}

// ============ read-only delivery management ============

/**
 * `GET /v1/webhooks/deliveries` — deliveries inside the tenant, newest first,
 * with the observable retry state (`attempts`, `next_retry_at`). Reads write
 * no audit row (§4.4).
 */
export async function listDeliveries(
  actor: WebhookActor,
  query: unknown,
): Promise<WebhookDeliveryRecord[]> {
  const filters = parseDeliveryFilters(query, actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_delivery.list');
  const conditions = ['tenant_id = $1'];
  const values: unknown[] = [actor.tenantId];
  if (filters.subscriptionId !== null) {
    values.push(filters.subscriptionId);
    conditions.push(`subscription_id = $${values.length}`);
  }
  if (filters.status !== null) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.event !== null) {
    values.push(filters.event);
    conditions.push(`event = $${values.length}`);
  }
  const result = await actor.client.query(
    `SELECT id, tenant_id, subscription_id, event, url, status, attempts, next_retry_at, created_at ` +
      `FROM webhook_deliveries WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY created_at DESC LIMIT ${WEBHOOK_LIST_LIMIT}`,
    values,
  );
  return readRows(result).map(mapDeliveryRow);
}

/** `GET /v1/webhooks/deliveries/:id` — one delivery with its retry state. */
export async function getDelivery(actor: WebhookActor, id: string): Promise<WebhookDeliveryRecord> {
  const deliveryId = requireUuidParam(id, 'delivery id', actor.traceId);
  const { membership, scopeSubtree } = await loadFacts(actor);
  await authorizeAdmin(actor, membership, scopeSubtree, 'webhook_delivery.open');
  const result = await actor.client.query(SELECT_DELIVERY_SQL, [actor.tenantId, deliveryId]);
  const row = readRows(result)[0];
  if (row === undefined) throw notFound('Webhook delivery', actor.traceId);
  return mapDeliveryRow(row);
}

// ============ outbox writer ============

/**
 * Fans one business fact out to every active subscription matching the event.
 * Runs INSIDE the emitter's transaction (same `client`, no BEGIN/COMMIT):
 * the delivery rows commit or roll back atomically with the business write.
 *
 * Each delivery freezes the target URL and the exact payload bytes at enqueue
 * time and starts `queued` with `attempts = 0`; the worker in
 * `apps/workers/src/webhook-deliver.ts` moves it to `sent` or reschedules it
 * with `next_retry_at` following `WEBHOOK=[60,300,1800,7200,21600]`.
 *
 * No guard runs here on purpose: the emitter already authorized the business
 * action, and this writer only fans out within the same tenant. A tenant with
 * no matching subscription enqueues nothing and returns an empty array.
 */
export async function enqueueWebhooks(
  client: WebhookClient,
  tenantId: string,
  input: WebhookEnqueueInput,
): Promise<WebhookDeliveryRecord[]> {
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(input.eventId)) return [];
  if (!(WEBHOOK_EVENTS as readonly string[]).includes(input.event)) return [];
  let payloadText: string;
  try {
    payloadText = JSON.stringify(input.payload);
  } catch {
    return [];
  }
  const targets = await client.query(SELECT_ACTIVE_SUBSCRIPTIONS_SQL, [tenantId, input.event]);
  const deliveries: WebhookDeliveryRecord[] = [];
  for (const target of readRows(targets)) {
    const subscriptionId = readString(target.id);
    const url = readString(target.url);
    if (subscriptionId === undefined || url === undefined) continue;
    const inserted = await client.query(INSERT_DELIVERY_SQL, [
      tenantId,
      subscriptionId,
      input.eventId,
      url,
      input.event,
      payloadText,
    ]);
    const row = readRows(inserted)[0];
    if (row !== undefined) deliveries.push(mapDeliveryRow(row));
  }
  return deliveries;
}

/**
 * Billing fan-out kept for `billing.service.ts`: delegates to the generic
 * writer so the invoice piggyback points keep their shape.
 */
export async function enqueueInvoiceWebhooks(
  client: WebhookClient,
  tenantId: string,
  input: InvoiceWebhookInput,
): Promise<WebhookDeliveryRecord[]> {
  return enqueueWebhooks(client, tenantId, {
    event: input.event,
    eventId: input.invoiceId,
    payload: input.payload,
  });
}

/**
 * `onboarding.closed` fan-out for the tenant provisioning that persists the
 * acta: same-tx writer, no guard — the provisioning already owns the tenant.
 * The wizard close itself (`onboarding/store.ts`) is pre-tenant and cannot
 * fan out, so it only closes the case; whoever creates the tenant from the
 * closed case calls this in that same business transaction with the closed
 * case facts.
 */
export async function enqueueOnboardingClosed(
  client: WebhookClient,
  tenantId: string,
  input: OnboardingClosedWebhookInput,
): Promise<WebhookDeliveryRecord[]> {
  if (!UUID_RE.test(input.caseId)) return [];
  return enqueueWebhooks(client, tenantId, {
    event: 'onboarding.closed',
    eventId: input.caseId,
    payload: {
      caseId: input.caseId,
      idempotencyKey: input.idempotencyKey,
      actaHash: input.actaHash,
    },
  });
}
