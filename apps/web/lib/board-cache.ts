// Generic client cache for a dashboard screen, with a short TTL.
//
// Why a factory and not one more module-level map: the obras vertical needs two
// more caches (site board, company board) than the salud role boards, and three
// near-identical maps is how the TTL, the stale-on-read rule and the key shape
// start to drift. `createBoardCache` is that rule once; each vertical owns only
// its key function and its board type.
//
// The semantics are the ones `lib/salud-board-cache.ts` already had, because
// they were right:
//   - the TTL is short on purpose: this is a cache of a *screen*, not of a
//     decision, and the API remains the only source of truth;
//   - a stale entry is dropped on read, so the map cannot grow with the session;
//   - the caller stores the board under the identity the API echoed back, so a
//     key always describes the value it holds.
//
// It is deliberately not shared state between users: the module lives in the
// browser tab that read the board, and the board is already filtered by the
// caller scope in the API.

/** How long a cached board is served before the next read replaces it. */
export const BOARD_CACHE_TTL_MS = 60_000;

/** One cached value with the instant it was stored. */
interface CacheEntry<T> {
  readonly value: T;
  readonly storedAt: number;
}

/** Read/write surface of one cache instance. */
export interface BoardCache<T> {
  /** Value for `key`, or `null` when absent or older than the TTL. */
  read(key: string, now?: number): T | null;
  /** Stores `value` under `key`. */
  write(key: string, value: T, now?: number): void;
  /** Drops one entry, or every entry when `key` is omitted. */
  clear(key?: string): void;
  /** Live entry count, for tests and diagnostics. */
  size(): number;
}

/**
 * Creates one isolated cache with `ttlMs` lifetime. `ttlMs` defaults to
 * {@link BOARD_CACHE_TTL_MS}; a non-finite or non-positive value falls back to
 * the default instead of making every read a miss.
 */
export function createBoardCache<T>(ttlMs: number = BOARD_CACHE_TTL_MS): BoardCache<T> {
  const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : BOARD_CACHE_TTL_MS;
  const entries = new Map<string, CacheEntry<T>>();

  return {
    read(key: string, now: number = Date.now()): T | null {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (now - entry.storedAt > lifetime) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    write(key: string, value: T, now: number = Date.now()): void {
      entries.set(key, { value, storedAt: now });
    },
    clear(key?: string): void {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}
