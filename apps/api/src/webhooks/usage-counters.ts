// Usage counters — W3: per-API-key hourly endpoint counts (`008_usage_counters`).
//
// Counts the machine calls a tenant answers with 2xx so operators can observe
// API-key consumption per endpoint and hour. The writer is deliberately
// best-effort and framework-free:
//   1. the request already passed the tenant middleware (RLS is bound, the
//      transaction is open) and answered 2xx;
//   2. the middleware calls `recordApiKeyUsage` with the verified key id, the
//      normalized endpoint and the served instant — one
//      `INSERT ... ON CONFLICT DO UPDATE` bumps the (tenant, key, endpoint,
//      hour) row, creating it at `count = 1` on first use;
//   3. a counting failure never fails the business request: the writer logs
//      one JSON line and resolves.
//
// Only `X-Api-Key` calls are counted (`apiKeyId` null/blank or a non-2xx
// status returns before touching the database). JWT and local-header traffic
// is operator-driven, not machine consumption, so it stays out of the counters.
//
// Like `webhooks.ts`: no decorators, so the module stays loadable by Node's
// strip-only TypeScript (`node --test`).

/** Hourly bucket: one row counts one (tenant, key, endpoint, hour). */
export const USAGE_COUNTER_WINDOW_MS = 3_600_000;

/** Counter family bound to the legacy 001 `metric` column (NOT NULL). */
export const USAGE_COUNTER_METRIC = 'api.calls';

/** Longest endpoint stored (`METHOD /path`, query stripped). */
export const USAGE_COUNTER_MAX_ENDPOINT_LENGTH = 200;

/** Minimal query surface, satisfied by the pooled client bound to a request. */
export interface UsageCounterClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** Everything the middleware knows at `finish` time. */
export interface UsageCounterInput {
  readonly tenantId: string;
  /** Verified API-key id; null/blank (JWT, local headers) disables counting. */
  readonly apiKeyId: string | null | undefined;
  /** Normalized `METHOD /path` (see `buildUsageEndpoint`). */
  readonly endpoint: string;
  /** Instant served; defaults to `now` (tests pin it). */
  readonly at?: Date | string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Truncates an instant to the UTC hour that opens its counting window,
 * returned as ISO. `2026-09-25T10:37:12Z` → `2026-09-25T10:00:00.000Z`.
 */
export function truncateToHour(value: Date | string): string {
  const at = value instanceof Date ? value : new Date(value);
  const time = at.getTime();
  if (!Number.isFinite(time)) return new Date(0).toISOString();
  return new Date(Math.floor(time / USAGE_COUNTER_WINDOW_MS) * USAGE_COUNTER_WINDOW_MS).toISOString();
}

/**
 * Builds the stored endpoint from the request method and path: upper-cased
 * method, query string stripped, guaranteed leading slash, capped at
 * `USAGE_COUNTER_MAX_ENDPOINT_LENGTH` so a crafted path cannot widen the row.
 */
export function buildUsageEndpoint(method: string, path: string): string {
  const verb = method.trim().toUpperCase() === '' ? 'UNKNOWN' : method.trim().toUpperCase();
  const bare = path.split('?')[0]?.trim() ?? '';
  const normalized = bare.startsWith('/') ? bare : `/${bare}`;
  return `${verb} ${normalized}`.slice(0, USAGE_COUNTER_MAX_ENDPOINT_LENGTH);
}

/**
 * Gate the middleware evaluates on `finish`: count only machine (`X-Api-Key`)
 * calls the API answered with 2xx. Everything else — JWT traffic, local-header
 * tooling, 3xx/4xx/5xx answers — returns false before any SQL runs.
 */
export function shouldCountUsage(
  apiKeyId: string | null | undefined,
  statusCode: number,
): boolean {
  if (apiKeyId === null || apiKeyId === undefined || apiKeyId.trim() === '') return false;
  if (!UUID_RE.test(apiKeyId.trim())) return false;
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
}

/**
 * Single-statement upsert: creates the (tenant, key, endpoint, hour) row at
 * `count = 1` or bumps it by one. `metric`/`period` feed the legacy 001
 * NOT NULL columns (counter family + hour bucket); the W3 columns carry the
 * queryable dimensions.
 */
export const RECORD_USAGE_COUNTER_SQL = `INSERT INTO usage_counters
  (tenant_id, api_key_id, endpoint, window_start, count, metric, period)
VALUES ($1, $2, $3, $4::timestamptz, 1, $5, $6)
ON CONFLICT (tenant_id, api_key_id, endpoint, window_start)
DO UPDATE SET count = usage_counters.count + 1`;

/**
 * Counts one served machine call. Best-effort by contract: invalid ids, a
 * blank endpoint and any database failure resolve without a row and without
 * throwing — counting must never fail a served request.
 */
export async function recordApiKeyUsage(
  client: UsageCounterClient,
  input: UsageCounterInput,
): Promise<void> {
  const tenantId = input.tenantId?.trim() ?? '';
  const apiKeyId = input.apiKeyId?.trim() ?? '';
  const endpoint = input.endpoint?.trim() ?? '';
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(apiKeyId) || endpoint === '') return;
  const windowStart = truncateToHour(input.at ?? new Date());
  try {
    await client.query(RECORD_USAGE_COUNTER_SQL, [
      tenantId,
      apiKeyId,
      endpoint,
      windowStart,
      USAGE_COUNTER_METRIC,
      windowStart,
    ]);
  } catch (error) {
    console.error(
      JSON.stringify({
        code: 'usage.counter_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
