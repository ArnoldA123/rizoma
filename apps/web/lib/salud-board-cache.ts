// Client cache of the salud role boards.
//
// The consolidated bases put the dashboards behind a 5–15 minute cache on a read
// replica; MVP1 has neither, so the web carries a much smaller version of the
// same idea: a short-lived module-level map keyed by `role|org|date`.
//
// What it buys, concretely: switching between the day navigation, the sede field
// and the poll selector re-reads the board without blanking the screen, so the
// numbers a user was reading stay on screen while the fresh answer travels.
//
// The mechanism itself now lives in `lib/board-cache.ts`, generic over the board
// type, because the obras boards (W4) needed the same TTL/stale-on-read rule for
// two more keys. This module keeps the salud-specific key and the names the
// salud screens already import, so the refactor changed no caller.
import type { SaludDashboardBoard } from '@rizoma/contracts';
import { BOARD_CACHE_TTL_MS, createBoardCache } from './board-cache.ts';

export { BOARD_CACHE_TTL_MS };

const CACHE = createBoardCache<SaludDashboardBoard>();

/** Identity of one board read: role, sede and day. */
export function boardCacheKey(role: string, orgNodeId: string, date: string): string {
  return `${role}|${orgNodeId}|${date}`;
}

/**
 * Cached board for that identity, or `null` when absent or older than the TTL.
 * A stale entry is dropped on read, so the map cannot grow with the session.
 */
export function readBoardCache(
  role: string,
  orgNodeId: string,
  date: string,
  now: number = Date.now(),
): SaludDashboardBoard | null {
  return CACHE.read(boardCacheKey(role, orgNodeId, date), now);
}

/**
 * Stores one board under the identity the API echoed back (`role`, `orgNodeId`,
 * `date`), so the key always describes the board it holds.
 */
export function writeBoardCache(board: SaludDashboardBoard, now: number = Date.now()): void {
  CACHE.write(boardCacheKey(board.role, board.orgNodeId, board.date), board, now);
}

/** Drops every entry; used by the screens when the sede changes. */
export function clearBoardCache(): void {
  CACHE.clear();
}
