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
import { saludDashboardBoardSchema } from '@rizoma/contracts';
import { apiErrorFromResponse, proxyRequest } from './api-client.ts';
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

// ============ comparison (?compare=previous-week) and CSV export ============
//
// Every role board is comparable day-vs-−7d and exportable as CSV. The
// contracts package owns the board schemas but not the compared/export
// shapes, so this module owns the query builders, the runtime validation of
// the `{current, previous, delta}` envelope and the download. A comparison is
// always a fresh read (no cache): it exists for the on-screen drift, while
// the base board keeps its one-minute cache.

/** `?compare=` modes the board screens offer. `off` sends no parameter. */
export const BOARD_COMPARE_MODES = ['off', 'previous-week'] as const;
export type BoardCompareMode = (typeof BOARD_COMPARE_MODES)[number];

/** Query of a compared board read. */
export interface ComparedBoardQuery {
  readonly org?: string;
  readonly date?: string;
}

/** `{current, previous, delta}` as `GET ...?compare=previous-week` answers. */
export interface ComparedSaludBoard {
  readonly current: SaludDashboardBoard;
  readonly previous: SaludDashboardBoard;
  readonly delta: Readonly<Record<string, number>>;
}

/** One board CSV download: the filename and the text to save. */
export interface BoardCsvDownload {
  readonly filename: string;
  readonly csv: string;
}

/** Base path of the vertical, mirroring `@Controller('salud/...')`. */
const SALUD_BASE = '/salud';

/**
 * Query string of a compared board read (`org`, `date`, `compare`, in the
 * order the service reads them). `compare: 'off'` sends no parameter, so the
 * endpoint answers the plain board.
 */
export function saludBoardCompareQueryString(
  query: ComparedBoardQuery & { readonly compare?: BoardCompareMode } = {},
): string {
  const parts: string[] = [];
  if (query.org !== undefined && query.org !== '') parts.push(`org=${encodeURIComponent(query.org)}`);
  if (query.date !== undefined && query.date !== '') parts.push(`date=${encodeURIComponent(query.date)}`);
  if (query.compare !== undefined && query.compare !== 'off') {
    parts.push(`compare=${encodeURIComponent(query.compare)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** Path of `GET /v1/salud/dashboards/:role/export?org=&date=&format=csv`. */
export function saludBoardExportUrl(role: string, query: ComparedBoardQuery = {}): string {
  const parts: string[] = [];
  if (query.org !== undefined && query.org !== '') parts.push(`org=${encodeURIComponent(query.org)}`);
  if (query.date !== undefined && query.date !== '') parts.push(`date=${encodeURIComponent(query.date)}`);
  parts.push('format=csv');
  return `${SALUD_BASE}/dashboards/${encodeURIComponent(role)}/export?${parts.join('&')}`;
}

/**
 * Reads `GET /v1/salud/dashboards/:role?compare=previous-week` and validates
 * the envelope: both legs with the board schema, the drift as finite numbers.
 */
export async function fetchComparedSaludBoard(
  role: string,
  query: ComparedBoardQuery = {},
  signal?: AbortSignal,
): Promise<ComparedSaludBoard> {
  const path = `${SALUD_BASE}/dashboards/${encodeURIComponent(role)}${saludBoardCompareQueryString({ ...query, compare: 'previous-week' })}`;
  const response = await proxyRequest(path, signal === undefined ? {} : { signal });
  if (!response.ok) throw await apiErrorFromResponse(response);
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('La respuesta del API no cumple el contrato del tablero comparado.');
  }
  const { current, previous, delta } = payload as Record<string, unknown>;
  const parsedCurrent = saludDashboardBoardSchema.safeParse(current);
  const parsedPrevious = saludDashboardBoardSchema.safeParse(previous);
  if (!parsedCurrent.success || !parsedPrevious.success) {
    throw new Error('La respuesta del API no cumple el contrato del tablero comparado.');
  }
  return { current: parsedCurrent.data, previous: parsedPrevious.data, delta: readDelta(delta) };
}

/**
 * Downloads the CSV export of one board. The proxy forwards the upstream
 * `content-disposition`, so the file is named by the server; the local
 * fallback only covers a missing or unsafe header.
 */
export async function downloadSaludBoardCsv(
  role: string,
  query: ComparedBoardQuery = {},
): Promise<BoardCsvDownload> {
  const response = await proxyRequest(saludBoardExportUrl(role, query));
  if (!response.ok) throw await apiErrorFromResponse(response);
  const csv = await response.text();
  const fallback = isSafeFilename(`tablero-${role}.csv`) ? `tablero-${role}.csv` : 'tablero.csv';
  return {
    filename: boardExportFilename(fallback, response.headers.get('content-disposition')),
    csv,
  };
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
 * `errorsCsvFilename` in `lib/salud-download.ts`: a path separator, a control
 * character or a leading dot refuses the header value.
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
