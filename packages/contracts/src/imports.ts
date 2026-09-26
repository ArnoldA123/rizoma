// CSV import contracts — the shape of `apps/api/src/salud/import.service.ts`
// (bases-consolidadas-v1.md §5.1, §5.4).
//
// One contract covers both halves of an import: the body the client posts (the
// raw CSV text plus the sede) and the job record the API answers with, errors
// CSV included. The CSV travels as text and not as a multipart file because
// that is what the service parses — `POST /v1/salud/imports/patients` takes
// `{csv, orgNodeId}` and derives its own replay key from the SHA-256 of the CSV
// bytes (§5.4: «toda importación es idempotente por hash del archivo»).
//
// Because the API's idempotency key is the file hash, the client sends the same
// digest as its `Idempotency-Key` header: a re-upload of the same bytes from a
// fresh page or a different browser collapses into the original job, which a
// random per-click key could not do.
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';
import { pagedListSchema, paginationQuerySchema } from './pagination.ts';

/** `import_jobs.kind` of the patients importer (§5.4). */
export const IMPORT_JOB_KIND_PATIENT_FILES_CSV = 'patient_files_csv';

/** `import_jobs.kind` of the obras workers importer (W5). */
export const IMPORT_JOB_KIND_WORKERS_CSV = 'workers_csv';

/** `import_jobs.kind` of the obras equipment importer (W5). */
export const IMPORT_JOB_KIND_ASSETS_CSV = 'assets_csv';

/** `import_jobs.status` (migration 001; the importer writes `completed`). */
export const IMPORT_JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;

/**
 * Columns the importer reads by name. Unknown columns are ignored by the
 * service, so the screen can show this list as the expected header instead of
 * refusing a file that carries more.
 */
export const PATIENTS_CSV_COLUMNS = [
  'person_name',
  'document_type',
  'document_number',
  'birthdate',
  'phone',
  'org_node_id',
] as const;

/** Columns whose absence makes the whole file unusable (`import.invalid_csv`). */
export const PATIENTS_CSV_REQUIRED_COLUMNS = [
  'person_name',
  'document_type',
  'document_number',
] as const;

// ============ obras CSV catalogues (W5) ============
//
// Field-for-field mirror of the parsers in `apps/api/src/obras/import.service.ts`
// (`parseWorkersCsv`, `parseAssetsCsv`). Each catalogue is split in two because a
// file with an unknown column is *not* refused: the service reads the columns it
// names and ignores the rest, so only the required set can make a whole file
// unusable (`import.invalid_csv`). The screen shows both lists as the expected
// header, exactly like the patients importer does.

/** `import_jobs.kind` values the two obras importers write. */
export const OBRAS_IMPORT_KINDS = [IMPORT_JOB_KIND_WORKERS_CSV, IMPORT_JOB_KIND_ASSETS_CSV] as const;
export type ObrasImportKind = (typeof OBRAS_IMPORT_KINDS)[number];

/** Construction roles a workers row may carry, mirroring `CONSTRUCTION_ROLES`. */
export const CONSTRUCTION_ROLES = [
  'gerente',
  'jefe_obra',
  'almacen',
  'capataz',
  'trabajador',
] as const;
export type ConstructionRole = (typeof CONSTRUCTION_ROLES)[number];

/** Columns the workers importer reads by name. */
export const WORKERS_CSV_COLUMNS = ['name', 'email', 'phone', 'role', 'org_node_id'] as const;

/** Columns whose absence makes a workers file unusable (`import.invalid_csv`). */
export const WORKERS_CSV_REQUIRED_COLUMNS = ['name', 'email', 'role'] as const;

/** Columns the equipment importer reads by name. */
export const ASSETS_CSV_COLUMNS = ['code', 'kind', 'serial', 'horometer', 'org_node_id'] as const;

/** Columns whose absence makes an equipment file unusable (`import.invalid_csv`). */
export const ASSETS_CSV_REQUIRED_COLUMNS = ['code', 'kind', 'serial'] as const;

// ============ import bodies ============

/**
 * Body shared by every CSV importer: the raw CSV text plus the sede the run is
 * scoped to. A per-row `org_node_id` may override the request's sede, which is
 * why the field is the *default* sede and not a filter.
 *
 * The CSV travels as text and not as a multipart file because that is what the
 * services parse, and because the replay key they derive — the SHA-256 of these
 * bytes — only exists if the client holds the bytes.
 */
export const csvImportInputSchema = z.object({
  /** Raw CSV text, header included. The bytes, not a path: the hash is the key. */
  csv: z.string().refine((value) => value.trim() !== '', 'Expected non-empty CSV text'),
  /** Sede the run is scoped to; a per-row `org_node_id` may override it. */
  orgNodeId: uuidSchema,
});
export type CsvImportInput = z.infer<typeof csvImportInputSchema>;

/** Body of `POST /v1/salud/imports/patients`. */
export const patientsImportInputSchema = csvImportInputSchema;
export type PatientsImportInput = CsvImportInput;

/** Body of `POST /v1/obras/imports/workers` (`assignment.write`). */
export const workersImportInputSchema = csvImportInputSchema;
export type WorkersImportInput = CsvImportInput;

/** Body of `POST /v1/obras/imports/assets` (`site.write`, gerente only). */
export const assetsImportInputSchema = csvImportInputSchema;
export type AssetsImportInput = CsvImportInput;

/**
 * One import run, as `GET /v1/salud/imports/:id` answers it: the counters, the
 * source file digest and — when the run had refused rows — the errors CSV
 * itself, so the download needs no second contract.
 */
export const importJobRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  /** `patient_files_csv`, `workers_csv` or `assets_csv`. */
  kind: z.string(),
  /** `queued` | `running` | `completed` | `failed`. */
  status: z.string(),
  rowsOk: z.number(),
  rowsError: z.number(),
  /** Attachment id of the source CSV (metadata only in MVP1). */
  fileId: uuidSchema.nullable(),
  /** SHA-256 of the source CSV — the replay key of §5.4. */
  fileSha256: z.string().nullable(),
  /** Attachment id of the downloadable errors CSV, when the run had errors. */
  errorsFileId: uuidSchema.nullable(),
  /** Errors CSV text; `null` when every row was accepted. */
  errorsCsv: z.string().nullable(),
  createdAt: isoValueSchema,
});
export type ImportJobRecord = z.infer<typeof importJobRecordSchema>;

/** `true` when the run refused nothing, so there is no errors CSV to read. */
export function importJobIsClean(job: Pick<ImportJobRecord, 'rowsError'>): boolean {
  return job.rowsError === 0;
}

/**
 * One import job as the `GET /v1/imports/jobs` listing exposes it: identity,
 * kind, outcome and counters. The source digests and the errors CSV stay on
 * the detail route (`GET .../imports/:id`), so a wide scan never drags the
 * file payloads along.
 */
export const importJobListItemSchema = importJobRecordSchema.pick({
  id: true,
  kind: true,
  status: true,
  rowsOk: true,
  rowsError: true,
  createdAt: true,
});
export type ImportJobListItem = z.infer<typeof importJobListItemSchema>;

/**
 * `GET /v1/imports/jobs` — bare array capped at 200 (legacy path, no cursor),
 * newest first.
 */
export const importJobListSchema = z.array(importJobListItemSchema);
export type ImportJobList = z.infer<typeof importJobListSchema>;

/**
 * Query filters of `GET /v1/imports/jobs`, field-for-field what the service
 * parser (`parseImportJobListFilters` in `imports.service.ts`) accepts.
 */
export const importJobListQuerySchema = z.object({
  kind: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
export type ImportJobListQuery = z.infer<typeof importJobListQuerySchema>;

/** Keyset query (`?cursor=` / `?limit=`) shared with every R1 listing. */
export const importJobPageQuerySchema = paginationQuerySchema;
export type ImportJobPageQuery = z.infer<typeof importJobPageQuerySchema>;

/** Keyset page of `GET /v1/imports/jobs` (`{rows, nextCursor}`). */
export const importJobPagedSchema = pagedListSchema(importJobListItemSchema);
export type ImportJobPaged = z.infer<typeof importJobPagedSchema>;
