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
import { companyBoardSchema, siteBoardSchema } from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { apiErrorFromResponse, proxyRequest } from './api-client.ts';
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

// ============ comparison (?compare=previous-week) and CSV export ============
//
// Both obras boards are comparable day-vs-−7d and exportable as CSV. The
// contracts package owns the board schemas but not the compared/export
// shapes, so this module owns the query builders, the runtime validation of
// the `{current, previous, delta}` envelope and the download. A comparison is
// always a fresh read (no cache): it exists for the on-screen drift, while
// the base boards keep their one-minute cache.

/** `?compare=` modes the board screens offer. `off` sends no parameter. */
export const OBRAS_BOARD_COMPARE_MODES = ['off', 'previous-week'] as const;
export type ObrasBoardCompareMode = (typeof OBRAS_BOARD_COMPARE_MODES)[number];

/** Query of a compared site-board read. */
export interface ComparedSiteBoardQuery {
  readonly date?: string;
}

/** `{current, previous, delta}` of a site board comparison. */
export interface ComparedSiteBoard {
  readonly current: SiteBoard;
  readonly previous: SiteBoard;
  readonly delta: Readonly<Record<string, number>>;
}

/** `{current, previous, delta}` of a company board comparison. */
export interface ComparedCompanyBoard {
  readonly current: CompanyBoard;
  readonly previous: CompanyBoard;
  readonly delta: Readonly<Record<string, number>>;
}

/** One board CSV download: the filename and the text to save. */
export interface ObrasBoardCsvDownload {
  readonly filename: string;
  readonly csv: string;
}

/** Base path of the vertical, mirroring `@Controller('obras')`. */
const OBRAS_BASE = '/obras';

/** Query string of a compared site-board read (`date`, then `compare`). */
export function siteBoardCompareQueryString(
  query: ComparedSiteBoardQuery & { readonly compare?: ObrasBoardCompareMode } = {},
): string {
  const parts: string[] = [];
  if (query.date !== undefined && query.date !== '') parts.push(`date=${encodeURIComponent(query.date)}`);
  if (query.compare !== undefined && query.compare !== 'off') {
    parts.push(`compare=${encodeURIComponent(query.compare)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** Path of `GET /v1/obras/sites/:siteId/board/export?date=&format=csv`. */
export function siteBoardExportUrl(siteId: string, query: ComparedSiteBoardQuery = {}): string {
  const parts: string[] = [];
  if (query.date !== undefined && query.date !== '') parts.push(`date=${encodeURIComponent(query.date)}`);
  parts.push('format=csv');
  return `${OBRAS_BASE}/sites/${encodeURIComponent(siteId)}/board/export?${parts.join('&')}`;
}

/** Path of `GET /v1/obras/board/export?date=&format=csv`. */
export function companyBoardExportUrl(query: ComparedSiteBoardQuery = {}): string {
  const parts: string[] = [];
  if (query.date !== undefined && query.date !== '') parts.push(`date=${encodeURIComponent(query.date)}`);
  parts.push('format=csv');
  return `${OBRAS_BASE}/board/export?${parts.join('&')}`;
}

/**
 * Reads `GET /v1/obras/sites/:siteId/board?compare=previous-week` and
 * validates the envelope: both legs with the site schema, the drift as finite
 * numbers.
 */
export async function fetchComparedSiteBoard(
  siteId: string,
  query: ComparedSiteBoardQuery = {},
  signal?: AbortSignal,
): Promise<ComparedSiteBoard> {
  const path = `${OBRAS_BASE}/sites/${encodeURIComponent(siteId)}/board${siteBoardCompareQueryString({ ...query, compare: 'previous-week' })}`;
  const response = await proxyRequest(path, signal === undefined ? {} : { signal });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return readComparedBoard(await response.json(), siteBoardSchema);
}

/**
 * Reads `GET /v1/obras/board?compare=previous-week` and validates the
 * envelope the same way. The company endpoint takes no scope parameter: the
 * API aggregates the membership subtree and echoes the node it used.
 */
export async function fetchComparedCompanyBoard(signal?: AbortSignal): Promise<ComparedCompanyBoard> {
  const response = await proxyRequest(
    `${OBRAS_BASE}/board?compare=previous-week`,
    signal === undefined ? {} : { signal },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  return readComparedBoard(await response.json(), companyBoardSchema);
}

/**
 * Downloads the CSV export of one site board. The proxy forwards the upstream
 * `content-disposition`, so the file is named by the server.
 */
export async function downloadSiteBoardCsv(
  siteId: string,
  query: ComparedSiteBoardQuery = {},
): Promise<ObrasBoardCsvDownload> {
  const response = await proxyRequest(siteBoardExportUrl(siteId, query));
  if (!response.ok) throw await apiErrorFromResponse(response);
  const csv = await response.text();
  return {
    filename: boardExportFilename('tablero-obra.csv', response.headers.get('content-disposition')),
    csv,
  };
}

/** Downloads the CSV export of the company board. */
export async function downloadCompanyBoardCsv(
  query: ComparedSiteBoardQuery = {},
): Promise<ObrasBoardCsvDownload> {
  const response = await proxyRequest(companyBoardExportUrl(query));
  if (!response.ok) throw await apiErrorFromResponse(response);
  const csv = await response.text();
  return {
    filename: boardExportFilename('tablero-empresa.csv', response.headers.get('content-disposition')),
    csv,
  };
}

/** Validates one `{current, previous, delta}` envelope against a board schema. */
async function readComparedBoard<T>(
  payload: unknown,
  schema: ZodType<T>,
): Promise<{ readonly current: T; readonly previous: T; readonly delta: Readonly<Record<string, number>> }> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('La respuesta del API no cumple el contrato del tablero comparado.');
  }
  const { current, previous, delta } = payload as Record<string, unknown>;
  const parsedCurrent = schema.safeParse(current);
  const parsedPrevious = schema.safeParse(previous);
  if (!parsedCurrent.success || !parsedPrevious.success) {
    throw new Error('La respuesta del API no cumple el contrato del tablero comparado.');
  }
  return { current: parsedCurrent.data, previous: parsedPrevious.data, delta: readDelta(delta) };
}

/** Drift entries the API sent: finite numbers only, anything else is dropped. */
function readDelta(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('La respuesta del API no cumple el contrato del tablero comparado.');
  }
  const delta: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const numeric = typeof entry === 'number' ? entry : Number(entry);
    if (Number.isFinite(numeric)) delta[key] = numeric;
  }
  return delta;
}

/** Characters a downloaded filename may not carry (same rule as the imports). */
const UNSAFE_FILENAME_RE = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * Filename of the board CSV: the upstream `Content-Disposition` when it names
 * one and the name is safe, the local fallback otherwise. Same strictness as
 * `errorsCsvFilename` in `lib/salud-download.ts`.
 */
function boardExportFilename(fallbackName: string, contentDisposition?: string | null): string {
  const header = contentDisposition ?? '';
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    const decoded = safeDecode(extended[1].trim().replace(/^"|"$/g, ''));
    if (isSafeFilename(decoded)) return decoded;
  }
  const plain = /filename="?([^"]+)"?/i.exec(header);
  if (plain?.[1] !== undefined) {
    const candidate = plain[1].trim();
    if (isSafeFilename(candidate)) return candidate;
  }
  return fallbackName;
}

function isSafeFilename(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false;
  if (value.startsWith('.')) return false;
  return !UNSAFE_FILENAME_RE.test(value);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}
