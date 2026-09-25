// Board cache (R2) — cache-aside over Redis for the salud and obras boards.
//
// Deliberately plain, like the dashboard services: no decorators, because
// `npm test` loads the sources through Node's strip-only TypeScript (which
// rejects decorator syntax). This module owns the cache contract:
//   1. namespaced keys (`rizoma:v1:{tenant}:...`) with per-vertical TTLs
//      (salud 900s, obras 300s) and JSON serialization;
//   2. cache-aside reads (`withBoardCache`) that are fail-open: a down, slow
//      or corrupt Redis degrades to reading the primary, never to a 500;
//   3. the compare (`previous-week`) envelope lives under its own key with a
//      `:prev7d` suffix, so a day board and its comparison never collide.
//
// Single source, no replica: there is no read replica in this deployment, so
// the cache sits in front of the same primary the request transaction reads.
// It only absorbs repeated identical reads (dashboard polling), it does not
// change what is read.
//
// Invalidation (v1, documented not faked): day-scoped writes (asistencia,
// pagos, avances) do NOT invalidate these keys. A board is fresh for its
// `{day}` window plus its TTL at most, which matches the web poll rhythm:
// the worst case is a same-day write surfacing up to TTL seconds late. Adding
// write-through invalidation is the follow-up; the key shape already carries
// the `{date}` segment that makes it possible.
export interface BoardCacheClient {
  get(key: string): Promise<string | null>;
  setex(key: string, ttlSeconds: number, value: string): Promise<unknown>;
}

/** Key namespace root: every board key starts with `rizoma:v1:`. */
export const BOARD_CACHE_NAMESPACE = 'rizoma';

/** Key schema version: bump to invalidate every board key at once. */
export const BOARD_CACHE_VERSION = 'v1';

/** Salud boards live 15 minutes: reception/cashier polling rhythm (§6.3). */
export const SALUD_BOARD_TTL_SECONDS = 900;

/** Obras boards live 5 minutes: site/company polling rhythm (§6.2). */
export const OBRAS_BOARD_TTL_SECONDS = 300;

/** Suffix of the key holding a `previous-week` comparison envelope. */
export const BOARD_COMPARE_KEY_SUFFIX = ':prev7d';

/**
 * Upper bound for one Redis round trip. Past it the read degrades to the
 * primary instead of holding the request open; the losing promise gets a
 * no-op catch so a late rejection cannot surface as unhandled.
 */
export const BOARD_CACHE_TIMEOUT_MS = 500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('board-cache.timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * One key segment. UUIDs, allowlisted roles and `YYYY-MM-DD` days pass
 * through unchanged; anything else (operator-controlled text such as a site
 * code is never a segment — ids only) is scrubbed to `[A-Za-z0-9._-]` so a
 * segment can never inject a `:` separator or a control character.
 */
export function scrubCacheSegment(segment: string): string {
  const scrubbed = segment.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
  return scrubbed === '' ? '-' : scrubbed;
}

function boardKeyPrefix(tenantId: string): string {
  return `${BOARD_CACHE_NAMESPACE}:${BOARD_CACHE_VERSION}:${scrubCacheSegment(tenantId)}`;
}

/** `rizoma:v1:{tenant}:salud:board:{role}:{org}:{date}`. */
export function saludBoardKey(
  tenantId: string,
  role: string,
  orgNodeId: string,
  date: string,
): string {
  return (
    `${boardKeyPrefix(tenantId)}:salud:board:` +
    `${scrubCacheSegment(role)}:${scrubCacheSegment(orgNodeId)}:${scrubCacheSegment(date)}`
  );
}

/** Day-board comparison: the board key plus `:prev7d`. */
export function saludComparedBoardKey(
  tenantId: string,
  role: string,
  orgNodeId: string,
  date: string,
): string {
  return `${saludBoardKey(tenantId, role, orgNodeId, date)}${BOARD_COMPARE_KEY_SUFFIX}`;
}

/** `rizoma:v1:{tenant}:obras:site:{siteId}:{date}`. */
export function obrasSiteBoardKey(tenantId: string, siteId: string, date: string): string {
  return (
    `${boardKeyPrefix(tenantId)}:obras:site:` +
    `${scrubCacheSegment(siteId)}:${scrubCacheSegment(date)}`
  );
}

/** Site-board comparison: the site key plus `:prev7d`. */
export function obrasSiteComparedBoardKey(
  tenantId: string,
  siteId: string,
  date: string,
): string {
  return `${obrasSiteBoardKey(tenantId, siteId, date)}${BOARD_COMPARE_KEY_SUFFIX}`;
}

/** `rizoma:v1:{tenant}:obras:company:{org}:{date}`. */
export function obrasCompanyBoardKey(tenantId: string, orgNodeId: string, date: string): string {
  return (
    `${boardKeyPrefix(tenantId)}:obras:company:` +
    `${scrubCacheSegment(orgNodeId)}:${scrubCacheSegment(date)}`
  );
}

/** Company-board comparison: the company key plus `:prev7d`. */
export function obrasCompanyComparedBoardKey(
  tenantId: string,
  orgNodeId: string,
  date: string,
): string {
  return `${obrasCompanyBoardKey(tenantId, orgNodeId, date)}${BOARD_COMPARE_KEY_SUFFIX}`;
}

/**
 * Reads one cached board. Misses, corrupt payloads and Redis failures all
 * resolve to `null` — the caller falls through to the primary. Never throws.
 */
export async function getBoard<T>(
  client: BoardCacheClient | null | undefined,
  key: string,
): Promise<T | null> {
  if (client === null || client === undefined) return null;
  try {
    const raw = await withTimeout(client.get(key), BOARD_CACHE_TIMEOUT_MS);
    if (typeof raw !== 'string' || raw === '') return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Stores one board as JSON with its vertical TTL. Best effort: a down Redis
 * or an unserializable value resolves without throwing. Never throws.
 */
export async function setBoard(
  client: BoardCacheClient | null | undefined,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (client === null || client === undefined) return;
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return;
  }
  if (typeof raw !== 'string') return;
  try {
    await withTimeout(client.setex(key, ttlSeconds, raw), BOARD_CACHE_TIMEOUT_MS);
  } catch {
    return;
  }
}

/**
 * Cache-aside read: the cached board when present, otherwise `loader()` (the
 * bounded primary SQL) whose result is stored best-effort before returning.
 * Loader failures propagate — a primary error is a real error — while every
 * cache failure degrades to the loader path. Never throws for cache reasons.
 */
export async function withBoardCache<T>(
  client: BoardCacheClient | null | undefined,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await getBoard<T>(client, key);
  if (cached !== null) return cached;
  const value = await loader();
  await setBoard(client, key, value, ttlSeconds);
  return value;
}
