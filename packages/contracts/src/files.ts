// File contracts — signed S3 upload/download (bases-consolidadas-v1.md §4.5).
//
// These mirror `apps/api/src/files/files.service.ts` field by field: the client
// pre-flights with these schemas, the service re-validates and is the only
// authority. No permanent public URL exists for any module; both the PUT and
// the GET URLs are pre-signed and capped at 5 minutes (`expiresIn <= 300`).
//
// The module imports only `zod` so `common.ts` can re-export it without an
// import cycle (same pattern as `onboarding.ts`).
import { z } from 'zod';

/** Canonical UUID shape shared with `common.ts` (kept local: no cycle). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 hex digest the client may declare before uploading. */
const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Closed module list of `files/paths.ts` (bases §2.1). The upload request is
 * refused for anything outside it, and the tenant must have the module active.
 */
export const FILE_MODULES = [
  'crm-core',
  'salud',
  'obras',
  'inventario',
  'asistencia',
  'facturacion',
  'reportes',
  'builder',
  'notify',
  'campo',
] as const;

export const fileModuleSchema = z.enum(FILE_MODULES);
export type FileModule = z.infer<typeof fileModuleSchema>;

/** UUID string (local copy: this module must not import `common.ts`). */
export const fileUuidSchema = z.string().regex(UUID_RE, 'Expected a UUID');

/** Signed URL lifetime cap in seconds (bases §4.5: ≤5 min). */
export const FILE_URL_TTL_SECONDS = 300;

/** Largest object the service accepts for a signed upload (25 MiB). */
export const FILE_SIZE_LIMIT_BYTES = 25_000_000;

/** Body of `POST /v1/files/request-upload`. */
export const fileUploadRequestSchema = z.object({
  /** Closed module list; also decides the guard action and the key prefix. */
  module: fileModuleSchema,
  /** MIME the client will send on the PUT; allow-listed by the service. */
  mime: z.string().trim().min(1).max(127),
  /** Declared object size; the service refuses non-positive and oversized. */
  sizeBytes: z.number().int().positive().max(FILE_SIZE_LIMIT_BYTES),
  /** Optional pre-computed digest, stored on the `attachments` row. */
  sha256: z.string().regex(SHA256_RE, 'Expected a 64-character hex digest').optional(),
});

export type FileUploadRequest = z.infer<typeof fileUploadRequestSchema>;

/** Answer of `POST /v1/files/request-upload`. */
export const fileUploadResponseSchema = z.object({
  attachmentId: fileUuidSchema,
  /** Canonical key `tenant/{id}/{module}/{yyyy}/{mm}/{uuid}`. */
  bucketKey: z.string().min(1),
  /** Pre-signed PUT URL, valid for `expiresIn` seconds. */
  uploadUrl: z.string().url(),
  /** Signed URL life, always `<= 300`. */
  expiresIn: z.number().int().positive().max(FILE_URL_TTL_SECONDS),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export type FileUploadResponse = z.infer<typeof fileUploadResponseSchema>;

/** Answer of `GET /v1/files/:id/download`. */
export const fileDownloadResponseSchema = z.object({
  attachmentId: fileUuidSchema,
  bucketKey: z.string().min(1),
  /** Pre-signed GET URL, valid for `expiresIn` seconds. Never permanent. */
  downloadUrl: z.string().url(),
  /** Signed URL life, always `<= 300`. */
  expiresIn: z.number().int().positive().max(FILE_URL_TTL_SECONDS),
  mime: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export type FileDownloadResponse = z.infer<typeof fileDownloadResponseSchema>;
