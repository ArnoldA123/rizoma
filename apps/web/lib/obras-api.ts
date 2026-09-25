// Browser API client for the Obras vertical (W4: ficha, personal, asistencia,
// tableros; W5: equipos, stock, avance, bitácora, importaciones CSV).
//
// Same three rules as `lib/salud-api.ts`, for the same reasons:
//
//   1. the response is parsed with the `@rizoma/contracts` schema of its
//      endpoint, so a drift fails at the edge with `api.contract_mismatch`;
//   2. every critical mutation carries a fresh `Idempotency-Key` per *user
//      intent* — generated inside the call, never inside a retry loop;
//   3. the body is pre-flighted with the same schema the API service validates
//      against, so an invalid payload is refused in the browser.
//
// What is specific to this vertical is the *two-step access key*, and it is not
// enforced here: `GET /v1/obras/sites/:siteId/staff` and the site board both
// resolve `requireSiteAccess` (central rule + active assignment, or an
// org-scoped manager). The client mirrors that rule with `resolveSiteAccess`
// before offering an action, but the API remains the only authority.
//
// Two W5 particularities worth naming:
//
//   - **The CSV importers key on the file hash, not on a random uuid.** The
//     services derive their own replay key from `sha256(csv)`, so the client
//     sends that digest as its `Idempotency-Key`; see `lib/browser-hash.ts`.
//   - **The other POSTs are idempotent by business key** (`assets.code`,
//     `inventory_items.sku`), not by the header: a duplicate answers
//     `obra.duplicate` (409) and the screen says so instead of retrying blindly.
import {
  assetAssignInputSchema,
  assetCreateInputSchema,
  assetReadingInputSchema,
  assetReadingRecordSchema,
  assetRecordSchema,
  assignmentCreateInputSchema,
  assignmentRecordSchema,
  assetsImportInputSchema,
  attendanceListSchema,
  attendanceMarkInputSchema,
  attendanceQueryString,
  attendanceRecordSchema,
  budgetLineCreateInputSchema,
  budgetLineRecordSchema,
  companyBoardSchema,
  importJobRecordSchema,
  inventoryItemRecordSchema,
  itemCreateInputSchema,
  milestoneCreateInputSchema,
  milestoneRecordSchema,
  progressEntriesQueryString,
  progressEntryCreateInputSchema,
  progressEntryListSchema,
  progressEntryRecordSchema,
  siteBoardQueryString,
  siteBoardSchema,
  siteCreateInputSchema,
  siteListSchema,
  siteLogCreateInputSchema,
  siteLogListSchema,
  siteLogRecordSchema,
  siteRecordSchema,
  siteStaffListSchema,
  stockMoveInputSchema,
  stockMoveRecordSchema,
  workersImportInputSchema,
  type AssetAssignInput,
  type AssetCreateInput,
  type AssetReadingInput,
  type AssetReadingRecord,
  type AssetRecord,
  type AssignmentCreateInput,
  type AssignmentRecord,
  type AssetsImportInput,
  type AttendanceMarkInput,
  type AttendanceQuery,
  type AttendanceRecord,
  type BudgetLineCreateInput,
  type BudgetLineRecord,
  type CompanyBoard,
  type ImportJobRecord,
  type InventoryItemRecord,
  type ItemCreateInput,
  type MilestoneCreateInput,
  type MilestoneRecord,
  type ProgressEntriesQuery,
  type ProgressEntryCreateInput,
  type ProgressEntryRecord,
  type SiteBoard,
  type SiteBoardQuery,
  type SiteCreateInput,
  type SiteLogCreateInput,
  type SiteLogRecord,
  type SiteRecord,
  type SiteStaffRecord,
  type StockMoveInput,
  type StockMoveRecord,
  type WorkersImportInput,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { apiErrorFromResponse, newIdempotencyKey, proxyRequest, requestJson } from './api-client.ts';
import { sha256Hex } from './browser-hash.ts';
import { errorsCsvFilename } from './salud-download.ts';

/** Base path of the vertical, mirroring `@Controller('obras/...')`. */
const BASE = '/obras';

/**
 * Reads a list endpoint. The API answers a bare array capped at 200 rows; an
 * empty body is normalized to `[]` so a screen distinguishes "no rows" from
 * "could not read".
 */
async function readList<T>(
  path: string,
  schema: ZodType<T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  const rows = await requestJson(path, schema, signal === undefined ? {} : { signal });
  return rows ?? [];
}

/** Reads one record; the API answers 404 with a typed envelope when absent. */
async function readOne<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
  const record = await requestJson(path, schema, signal === undefined ? {} : { signal });
  if (record === null) {
    throw new Error(`El API respondió sin cuerpo para ${path}`);
  }
  return record;
}

/** One JSON `POST` with a replay key and the endpoint's schema. */
async function postJson<T>(
  path: string,
  body: unknown,
  schema: ZodType<T>,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<T> {
  const record = await requestJson(path, schema, {
    method: 'POST',
    body,
    idempotencyKey,
  });
  if (record === null) throw new Error(`El API respondió sin cuerpo para ${path}`);
  return record;
}

// ============ sites ============

/** `GET /v1/obras/sites` — sites inside the membership subtree (`site.read`). */
export function listSites(signal?: AbortSignal): Promise<SiteRecord[]> {
  return readList(`${BASE}/sites`, siteListSchema, signal);
}

/** `POST /v1/obras/sites` — creates a site (`site.write`, gerente only). */
export function createSite(input: SiteCreateInput): Promise<SiteRecord> {
  const body = siteCreateInputSchema.parse(input);
  return postJson(`${BASE}/sites`, body, siteRecordSchema);
}

/** `GET /v1/obras/sites/:id` — opens one site (`site.read`). */
export function getSite(siteId: string, signal?: AbortSignal): Promise<SiteRecord> {
  return readOne(`${BASE}/sites/${encodeURIComponent(siteId)}`, siteRecordSchema, signal);
}

// ============ staff / assignments ============

/**
 * `GET /v1/obras/sites/:siteId/staff` — active assignments of the site.
 *
 * This read is the two-step rule made observable: it resolves
 * `requireSiteAccess`, so an assignment-scoped role without an active row gets a
 * 403 `obra.scope_denied` with `reason no_active_assignment` — the same token
 * the ficha renders as "fuera de obra".
 */
export function listSiteStaff(siteId: string, signal?: AbortSignal): Promise<SiteStaffRecord[]> {
  return readList(`${BASE}/sites/${encodeURIComponent(siteId)}/staff`, siteStaffListSchema, signal);
}

/**
 * `POST /v1/obras/sites/:siteId/staff` — assigns a worker
 * (`assignment.write`). The call is idempotent by `user + site` in the service:
 * an assignment already in force is returned untouched.
 */
export function assignWorker(
  siteId: string,
  input: AssignmentCreateInput,
): Promise<AssignmentRecord> {
  const body = assignmentCreateInputSchema.parse(input);
  return postJson(
    `${BASE}/sites/${encodeURIComponent(siteId)}/staff`,
    body,
    assignmentRecordSchema,
  );
}

/** `POST /v1/obras/sites/:siteId/staff/:userId/close` — ends the assignment. */
export function closeAssignment(siteId: string, userId: string): Promise<AssignmentRecord> {
  return postJson(
    `${BASE}/sites/${encodeURIComponent(siteId)}/staff/${encodeURIComponent(userId)}/close`,
    {},
    assignmentRecordSchema,
  );
}

// ============ attendance ============

/**
 * `POST /v1/obras/attendance` — marks the caller's own attendance.
 *
 * `userId` is deliberately never sent: the service denies a `userId` that is not
 * the token subject with `obra.access_denied` (`attendance.not_own`), so the
 * honest client omits the field and lets the API resolve the subject. The mark
 * additionally needs an active assignment to the site, whatever the role.
 */
export function markAttendance(input: AttendanceMarkInput): Promise<AttendanceRecord> {
  const body = attendanceMarkInputSchema.parse(input);
  return postJson(`${BASE}/attendance`, body, attendanceRecordSchema);
}

/** `POST /v1/obras/attendance/:id/approve` — approves one mark. */
export function approveAttendance(attendanceId: string): Promise<AttendanceRecord> {
  return postJson(
    `${BASE}/attendance/${encodeURIComponent(attendanceId)}/approve`,
    {},
    attendanceRecordSchema,
  );
}

/** `GET /v1/obras/attendance?site=&date=` — marks of one day at one site. */
export function listAttendance(
  query: AttendanceQuery,
  signal?: AbortSignal,
): Promise<AttendanceRecord[]> {
  return readList(`${BASE}/attendance${attendanceQueryString(query)}`, attendanceListSchema, signal);
}

// ============ boards ============

/**
 * `GET /v1/obras/sites/:siteId/board?date=` — the board of one site. Access
 * follows the same `requireSiteAccess` as the staff list, so it is only offered
 * once the ficha confirmed the caller can operate in the obra.
 */
export function getSiteBoard(
  siteId: string,
  query: SiteBoardQuery = {},
  signal?: AbortSignal,
): Promise<SiteBoard> {
  const path = `${BASE}/sites/${encodeURIComponent(siteId)}/board${siteBoardQueryString(query)}`;
  return readOne(path, siteBoardSchema, signal);
}

/** `GET /v1/obras/board` — the company board over the membership subtree. */
export function getCompanyBoard(signal?: AbortSignal): Promise<CompanyBoard> {
  return readOne(`${BASE}/board`, companyBoardSchema, signal);
}

// ============ equipment (assets) ============
//
// The vertical exposes no asset *list* endpoint in MVP1: units are registered,
// transitioned and read by identifier. The ficha therefore offers one target
// field shared with the board, which is the only place the API hands asset ids
// back (`maintenanceAssets`), and says so instead of rendering an empty table
// that would read as "no hay equipos".

/** `POST /v1/obras/assets` — registers an `available` unit (`site.write`). */
export function registerAsset(input: AssetCreateInput): Promise<AssetRecord> {
  const body = assetCreateInputSchema.parse(input);
  return postJson(`${BASE}/assets`, body, assetRecordSchema);
}

/**
 * `POST /v1/obras/assets/:id/assign` — assigns an `available` unit to a site
 * (`assignment.write`). Any other starting state answers `obra.asset_unavailable`.
 */
export function assignAsset(assetId: string, input: AssetAssignInput): Promise<AssetRecord> {
  const body = assetAssignInputSchema.parse(input);
  return postJson(`${BASE}/assets/${encodeURIComponent(assetId)}/assign`, body, assetRecordSchema);
}

/** `POST /v1/obras/assets/:id/maintenance` — sends the unit to service (`site.write`). */
export function setAssetMaintenance(assetId: string): Promise<AssetRecord> {
  return postJson(
    `${BASE}/assets/${encodeURIComponent(assetId)}/maintenance`,
    {},
    assetRecordSchema,
  );
}

/** `POST /v1/obras/assets/:id/retire` — retires the unit; it is not assignable again. */
export function retireAsset(assetId: string): Promise<AssetRecord> {
  return postJson(`${BASE}/assets/${encodeURIComponent(assetId)}/retire`, {}, assetRecordSchema);
}

/**
 * `POST /v1/obras/assets/:id/readings` — appends one manual reading.
 *
 * The guard is `attendance.mark` plus an active assignment to the unit's current
 * site (org-scoped managers are exempt), so a `gerente` reading a unit that is
 * not in a site it reaches gets `obra.scope_denied` with `no_active_assignment`
 * — the same token the ficha already renders.
 */
export function addAssetReading(
  assetId: string,
  input: AssetReadingInput,
): Promise<AssetReadingRecord> {
  const body = assetReadingInputSchema.parse(input);
  return postJson(
    `${BASE}/assets/${encodeURIComponent(assetId)}/readings`,
    body,
    assetReadingRecordSchema,
  );
}

// ============ warehouse stock ============

/** `POST /v1/obras/stock/items` — creates a warehouse item (`stock.consume`). */
export function createStockItem(input: ItemCreateInput): Promise<InventoryItemRecord> {
  const body = itemCreateInputSchema.parse(input);
  return postJson(`${BASE}/stock/items`, body, inventoryItemRecordSchema);
}

/**
 * `POST /v1/obras/stock/moves` — registers and posts a move in one step
 * (`stock.consume`).
 *
 * The service inserts with `status = 'posted'`, so the row counts towards the
 * warehouse's available quantity immediately: an `out` carries a `siteId` and
 * is what the ticket calls «consumo descuenta stock en posted». An `out` or
 * `transfer` above the posted quantity answers `obra.insufficient_stock` (409),
 * which the panel renders as a conflict and never retries.
 */
export function postStockMove(input: StockMoveInput): Promise<StockMoveRecord> {
  const body = stockMoveInputSchema.parse(input);
  return postJson(`${BASE}/stock/moves`, body, stockMoveRecordSchema);
}

/**
 * `POST /v1/obras/stock/moves/:id/reverse` — reverses a posted move
 * (`stock.consume`). The reversed row stays visible with `status = 'reversed'`:
 * a reversal never deletes the original, so the ledger keeps both facts.
 */
export function reverseStockMove(moveId: string): Promise<StockMoveRecord> {
  return postJson(
    `${BASE}/stock/moves/${encodeURIComponent(moveId)}/reverse`,
    {},
    stockMoveRecordSchema,
  );
}

// ============ budget, progress and milestones ============

/** `POST /v1/obras/progress/budget-lines` — creates a budget line (`site.write`). */
export function createBudgetLine(input: BudgetLineCreateInput): Promise<BudgetLineRecord> {
  const body = budgetLineCreateInputSchema.parse(input);
  return postJson(`${BASE}/progress/budget-lines`, body, budgetLineRecordSchema);
}

/**
 * `GET /v1/obras/progress/entries?site=` — posted entries of one site
 * (`site.read` plus the site key). The API caps the list at 200 rows and orders
 * it by `at DESC`.
 */
export function listProgressEntries(
  query: ProgressEntriesQuery,
  signal?: AbortSignal,
): Promise<ProgressEntryRecord[]> {
  return readList(
    `${BASE}/progress/entries${progressEntriesQueryString(query)}`,
    progressEntryListSchema,
    signal,
  );
}

/**
 * `POST /v1/obras/progress/entries` — posts an executed quantity. The service
 * inserts directly as `posted` and stamps `reported_by` from the token subject,
 * so the body never carries an author.
 */
export function postProgressEntry(input: ProgressEntryCreateInput): Promise<ProgressEntryRecord> {
  const body = progressEntryCreateInputSchema.parse(input);
  return postJson(`${BASE}/progress/entries`, body, progressEntryRecordSchema);
}

/** `POST /v1/obras/progress/milestones` — sets a milestone (`site.write`). */
export function createMilestone(input: MilestoneCreateInput): Promise<MilestoneRecord> {
  const body = milestoneCreateInputSchema.parse(input);
  return postJson(`${BASE}/progress/milestones`, body, milestoneRecordSchema);
}

// ============ site log (bitácora) ============

/**
 * `GET /v1/obras/sites/:siteId/logs` — the site log (`site.read` plus the site
 * key). Drafts and published entries both come back, newest first.
 */
export function listSiteLogs(siteId: string, signal?: AbortSignal): Promise<SiteLogRecord[]> {
  return readList(`${BASE}/sites/${encodeURIComponent(siteId)}/logs`, siteLogListSchema, signal);
}

/**
 * `POST /v1/obras/sites/:siteId/logs` — appends a **draft** entry
 * (`attendance.mark`, on-site). Publishing is its own endpoint, so this body
 * carries no status.
 */
export function createSiteLog(
  siteId: string,
  input: SiteLogCreateInput,
): Promise<SiteLogRecord> {
  const body = siteLogCreateInputSchema.parse(input);
  return postJson(`${BASE}/sites/${encodeURIComponent(siteId)}/logs`, body, siteLogRecordSchema);
}

/**
 * `POST /v1/obras/sites/:siteId/logs/:id/publish` — publishes a draft. A log
 * that is already published answers `obra.state_denied`, which is the honest
 * answer: the transition happened once.
 */
export function publishSiteLog(siteId: string, logId: string): Promise<SiteLogRecord> {
  return postJson(
    `${BASE}/sites/${encodeURIComponent(siteId)}/logs/${encodeURIComponent(logId)}/publish`,
    {},
    siteLogRecordSchema,
  );
}

// ============ CSV imports (workers / assets) ============

/**
 * `POST /v1/obras/imports/workers` — imports a workers CSV (`assignment.write`).
 *
 * The `Idempotency-Key` is the SHA-256 of the CSV bytes, the same digest the
 * service derives for itself: re-uploading the same file answers the original
 * job instead of creating workers twice.
 */
export async function importWorkersCsv(input: WorkersImportInput): Promise<ImportJobRecord> {
  const body = workersImportInputSchema.parse(input);
  return postJson(`${BASE}/imports/workers`, body, importJobRecordSchema, await sha256Hex(body.csv));
}

/**
 * `POST /v1/obras/imports/assets` — imports an equipment CSV (`site.write`, so
 * gerencia only). Same file-hash replay key as the workers importer.
 */
export async function importAssetsCsv(input: AssetsImportInput): Promise<ImportJobRecord> {
  const body = assetsImportInputSchema.parse(input);
  return postJson(`${BASE}/imports/assets`, body, importJobRecordSchema, await sha256Hex(body.csv));
}

/** `GET /v1/obras/imports/:id` — job detail, errors CSV included. */
export function getImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJobRecord> {
  return readOne(`${BASE}/imports/${encodeURIComponent(jobId)}`, importJobRecordSchema, signal);
}

/** One materialized errors-CSV download of an obras import job. */
export interface ObrasImportErrorsDownload {
  readonly filename: string;
  readonly csv: string;
}

/**
 * Reads the errors CSV of an obras job through the proxy and names the file.
 *
 * Same reasoning as the Salud importer (`lib/salud-api.ts`): the errors CSV is a
 * *download* of the run, and the proxy is the one path that carries
 * `content-disposition`. MVP1 has no attachment endpoint, so the text is
 * materialized from the job detail; the day the API streams it as a file, this
 * call already returns the upstream filename. A clean run answers `null`, so the
 * button is never offered.
 */
export async function fetchObrasImportErrorsCsv(
  jobId: string,
): Promise<ObrasImportErrorsDownload | null> {
  const path = `${BASE}/imports/${encodeURIComponent(jobId)}`;
  const response = await proxyRequest(path);
  if (!response.ok) throw await apiErrorFromResponse(response);

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  const parsed = importJobRecordSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('La respuesta del API no cumple el contrato de importación.');
  }
  const job = parsed.data;
  if (job.errorsCsv === null) return null;
  return {
    filename: errorsCsvFilename(job.id, response.headers.get('content-disposition')),
    csv: job.errorsCsv,
  };
}
