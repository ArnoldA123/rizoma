// Client cache of the obras boards (site and company).
//
// Same rule as the salud role boards — a short-lived map keyed by the identity
// of the read, stale-on-read, API remains the only source of truth — but two
// keys, because the obras vertical reads two boards:
//
//   - `site|<siteId>|<date>`   → `GET /v1/obras/sites/:siteId/board?date=`
//   - `company|<org>|<date>`   → `GET /v1/obras/board`
//
// The company board has no query parameter: the API aggregates the membership
// subtree and echoes the node it used, so the node id comes from the answer, not
// from the request. That is why `writeCompanyBoardCache` takes the board and not
// a key.
import type { CompanyBoard, SiteBoard } from '@rizoma/contracts';
import { BOARD_CACHE_TTL_MS, createBoardCache } from './board-cache.ts';

export { BOARD_CACHE_TTL_MS };

const SITE_CACHE = createBoardCache<SiteBoard>();
const COMPANY_CACHE = createBoardCache<CompanyBoard>();

/** Identity of the last company board this tab read; `null` before the first answer. */
let LAST_COMPANY_SCOPE: { readonly orgNodeId: string; readonly date: string } | null = null;

/** Identity of one site-board read: obra and day. */
export function siteBoardCacheKey(siteId: string, date: string): string {
  return `site|${siteId}|${date}`;
}

/** Cached site board, or `null` when absent or older than the TTL. */
export function readSiteBoardCache(
  siteId: string,
  date: string,
  now: number = Date.now(),
): SiteBoard | null {
  return SITE_CACHE.read(siteBoardCacheKey(siteId, date), now);
}

/** Stores one site board under the identity the API echoed back. */
export function writeSiteBoardCache(board: SiteBoard, now: number = Date.now()): void {
  SITE_CACHE.write(siteBoardCacheKey(board.siteId, board.date), board, now);
}

/** Identity of one company-board read: org node and day. */
export function companyBoardCacheKey(orgNodeId: string, date: string): string {
  return `company|${orgNodeId}|${date}`;
}

/** Cached company board, or `null` when absent or older than the TTL. */
export function readCompanyBoardCache(
  orgNodeId: string,
  date: string,
  now: number = Date.now(),
): CompanyBoard | null {
  return COMPANY_CACHE.read(companyBoardCacheKey(orgNodeId, date), now);
}

/** Stores one company board under the org node and day the API echoed back. */
export function writeCompanyBoardCache(board: CompanyBoard, now: number = Date.now()): void {
  COMPANY_CACHE.write(companyBoardCacheKey(board.orgNodeId, board.date), board, now);
  LAST_COMPANY_SCOPE = { orgNodeId: board.orgNodeId, date: board.date };
}

/**
 * Identity of the last company board this tab read, or `null` before the first
 * answer.
 *
 * Why it is needed: `GET /v1/obras/board` takes no parameter, so the cache key
 * can only be built from the *answer*. Without remembering the last identity, a
 * remount of the tablero could not consult its own cache and would always start
 * from the skeleton.
 */
export function lastCompanyBoardScope(): { readonly orgNodeId: string; readonly date: string } | null {
  return LAST_COMPANY_SCOPE;
}

/** Drops every obras entry; used when the user changes scope or day. */
export function clearObrasBoardCache(): void {
  SITE_CACHE.clear();
  COMPANY_CACHE.clear();
  LAST_COMPANY_SCOPE = null;
}
