// Salud contracts — row shapes of `apps/api/src/salud/*.service.ts`
// (bases-consolidadas-v1.md §2.3, §6.1; peru-anexo-v1.md §2).
//
// Scope is deliberately narrow: only the records the MVP1 web reads or writes.
// Request bodies are validated by the API services, not here, so no input
// schema is declared yet — W2/W3 add the ones they actually post, derived from
// the same source of truth.
import { z } from 'zod';
import {
  isoDateSchema,
  isoDateTimeSchema,
  isoValueSchema,
  jsonObjectSchema,
  uuidSchema,
} from './common.ts';

/** SHA-256 hex digest — the evidence fingerprint `signConsent` requires. */
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** `GET/POST /v1/salud/patients` — one patient file. */
export const patientRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  personName: z.string(),
  documentType: z.string(),
  documentNumber: z.string(),
  /** `YYYY-MM-DD` or `null`. */
  birthdate: isoValueSchema,
  allergies: z.array(z.string()),
  alerts: z.array(z.string()),
  contacts: jsonObjectSchema,
  active: z.boolean(),
  createdAt: isoValueSchema,
});

export type PatientRecord = z.infer<typeof patientRecordSchema>;

/** `GET/POST /v1/salud/episodes` — one clinical episode of a patient. */
export const episodeRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  patientId: uuidSchema,
  specialty: z.string(),
  professionalId: uuidSchema,
  openedAt: isoValueSchema,
  closedAt: isoValueSchema,
  /** `open` while the episode is active; the API owns the state machine. */
  status: z.string(),
});

export type EpisodeRecord = z.infer<typeof episodeRecordSchema>;

/** `GET/POST /v1/salud/appointments` — one scheduled appointment. */
export const appointmentRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  patientId: uuidSchema,
  professionalId: uuidSchema,
  startsAt: isoValueSchema,
  durationMin: z.number(),
  /** `scheduled` on insert; later `checked_in` / `in_care` / `done` / `no_show`. */
  status: z.string(),
  createdAt: isoValueSchema,
});

export type AppointmentRecord = z.infer<typeof appointmentRecordSchema>;

/** Consent statuses declared by `consents.service.ts` (§2.8). */
export const CONSENT_STATUSES = ['pending', 'signed', 'revoked', 'expired'] as const;
export const consentStatusSchema = z.enum(CONSENT_STATUSES);
export type ConsentStatus = z.infer<typeof consentStatusSchema>;

/** `SI`/`NO` marks of the recording decision matrix. */
export const RECORDING_MARKS = ['SI', 'NO'] as const;
export const recordingMarkSchema = z.enum(RECORDING_MARKS);
export type RecordingMark = z.infer<typeof recordingMarkSchema>;

/**
 * §2.6 recording types, in matrix order — the same four the API's
 * `RECORD_TYPES` declares, so the form that renders one toggle per type cannot
 * invent a type the service would refuse.
 */
export const CONSENT_RECORD_TYPES = ['imagenes_ayuda', 'fotografias', 'video', 'audio'] as const;
export type ConsentRecordType = (typeof CONSENT_RECORD_TYPES)[number];

/** Inclusive recording scope of §2.6: `SI` on `todo` enables every type. */
export const RECORDING_SCOPE_ALL = 'todo';

/** `todo` or one record type marked `SI`. */
export const consentRecordingSchema = z.record(z.string(), recordingMarkSchema);

/**
 * `GET/POST /v1/salud/consents` — one tele-interconsultation consent, with the
 * §2.6 gate (`canStartSession`) and the allowed recording types already derived
 * server-side so the UI never reimplements the decision matrix.
 */
export const consentRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  patientId: uuidSchema,
  templateCode: z.string(),
  templateVersion: z.string(),
  versionKey: z.string(),
  episodeId: uuidSchema,
  consultingCenter: z.string(),
  consultorCenter: z.string(),
  informedBy: z.string(),
  patientName: z.string(),
  docType: z.string(),
  docNumber: z.string(),
  actConsent: z.enum(['SI', 'NO']),
  recording: consentRecordingSchema,
  signedAt: isoValueSchema,
  evidenceAttachmentId: isoValueSchema,
  status: consentStatusSchema,
  /** Derived gate: `signed` + `actConsent === 'SI'`. */
  canStartSession: z.boolean(),
  /** Derived: recording types marked `SI`. */
  allowedRecordingTypes: z.array(z.string()),
});

export type ConsentRecord = z.infer<typeof consentRecordSchema>;

/** Query string of `GET /v1/salud/dashboards/:role` (`org`, `date`). */
export const saludBoardQuerySchema = z.object({
  org: uuidSchema.optional(),
  date: isoDateSchema.optional(),
});

export type SaludBoardQuery = z.infer<typeof saludBoardQuerySchema>;

// ============ state catalogs ============

/**
 * `patient_files.document_type` catalog, identical to `parsePatientCreate`.
 * Declared as, not as a bare string, because the registration form has to
 * refuse an invalid catalog entry before the API answers 400.
 */
export const DOCUMENT_TYPES = ['dni', 'ce', 'pasaporte'] as const;
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * `appointments.status` lifecycle (§2.3). The insert state is `scheduled`; the
 * rest is the state machine the database owns, mirrored so the UI labels a row
 * without inventing a status.
 */
export const APPOINTMENT_STATUSES = ['scheduled', 'checked_in', 'in_care', 'done', 'no_show'] as const;
export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

/** `episodes.status`: `open` on insert, `closed` by `PATCH /episodes/:id`. */
export const EPISODE_STATUSES = ['open', 'closed', 'cancelled'] as const;
export const episodeStatusSchema = z.enum(EPISODE_STATUSES);
export type EpisodeStatus = z.infer<typeof episodeStatusSchema>;

// ============ list responses ============
//
// Every `GET` of this vertical answers with a bare JSON array capped at
// `SALUD_LIST_LIMIT` (200) rows: there is no cursor pagination in MVP1. The
// client therefore paginates in the browser, and these schemas are what the
// web validates the envelope with before a row reaches a screen.

/** `GET /v1/salud/patients` — up to 200 patient files, most recent first. */
export const patientListSchema = z.array(patientRecordSchema);
export type PatientList = z.infer<typeof patientListSchema>;

/** `GET /v1/salud/episodes` — up to 200 episodes of the caller scope. */
export const episodeListSchema = z.array(episodeRecordSchema);
export type EpisodeList = z.infer<typeof episodeListSchema>;

/** `GET /v1/salud/appointments` — up to 200 appointments of the scope. */
export const appointmentListSchema = z.array(appointmentRecordSchema);
export type AppointmentList = z.infer<typeof appointmentListSchema>;

/** `GET /v1/salud/consents?patient=` — consent history of one patient. */
export const consentListSchema = z.array(consentRecordSchema);
export type ConsentList = z.infer<typeof consentListSchema>;

// ============ request bodies ============
//
// These mirror the API's own parsers field by field (`parsePatientCreate`,
// `parseEpisodeCreate`, `parseAppointmentCreate`, `parseConsentCreate`); they
// are the client-side pre-flight, never a substitute for the service, which
// re-validates and is the only authority.

/** Body of `POST /v1/salud/patients`. */
export const patientCreateInputSchema = z.object({
  /** Sede the file belongs to; the API scopes the write to it. */
  orgNodeId: uuidSchema,
  personName: z.string().min(1),
  documentType: documentTypeSchema,
  documentNumber: z.string().min(1),
  /** `YYYY-MM-DD`, or `null` when the patient did not provide it. */
  birthdate: isoDateSchema.nullable(),
  allergies: z.array(z.string()),
  alerts: z.array(z.string()),
  contacts: jsonObjectSchema,
});
export type PatientCreateInput = z.infer<typeof patientCreateInputSchema>;

/**
 * Body of `PATCH /v1/salud/patients/:id` — every field optional, because the
 * service merges the body over the current row (and nothing else).
 */
export const patientUpdateInputSchema = z.object({
  personName: z.string().min(1).optional(),
  birthdate: isoDateSchema.nullable().optional(),
  allergies: z.array(z.string()).optional(),
  alerts: z.array(z.string()).optional(),
  contacts: jsonObjectSchema.optional(),
  active: z.boolean().optional(),
});
export type PatientUpdateInput = z.infer<typeof patientUpdateInputSchema>;

/** Body of `POST /v1/salud/episodes` (`professionalId` defaults to the caller). */
export const episodeCreateInputSchema = z.object({
  patientId: uuidSchema,
  specialty: z.string().min(1),
  professionalId: uuidSchema.optional(),
});
export type EpisodeCreateInput = z.infer<typeof episodeCreateInputSchema>;

/** Body of `POST /v1/salud/appointments`. */
export const appointmentCreateInputSchema = z.object({
  orgNodeId: uuidSchema,
  patientId: uuidSchema,
  professionalId: uuidSchema,
  /** Offset-aware ISO-8601 instant; the API rejects an unparseable one. */
  startsAt: isoDateTimeSchema,
  durationMin: z.number().int().positive(),
});
export type AppointmentCreateInput = z.infer<typeof appointmentCreateInputSchema>;

/**
 * One `SI`/`NO` mark per recording type (plus the inclusive `todo`), with at
 * least one mark present — the same non-empty rule `parseRecording` enforces.
 */
export const consentRecordingInputSchema = consentRecordingSchema.refine(
  (recording) => Object.keys(recording).length > 0,
  'recording must carry at least one SI/NO mark',
);

/** §2.3 identity snapshot the signed consent reproduces. */
export const consentFormSchema = z.object({
  patientName: z.string().min(1),
  docType: documentTypeSchema,
  docNumber: z.string().min(1),
});
export type ConsentForm = z.infer<typeof consentFormSchema>;

/** Body of `POST /v1/salud/consents` — creates the `pending` row. */
export const consentCreateInputSchema = z.object({
  patientId: uuidSchema,
  episodeId: uuidSchema,
  consultingCenter: uuidSchema,
  consultorCenter: uuidSchema,
  informedBy: z.string().min(1),
  patientName: z.string().min(1),
  docType: documentTypeSchema,
  docNumber: z.string().min(1),
  /** Medical act: only `SI` authorizes the teleinterconsultation. */
  actConsent: z.enum(['SI', 'NO']),
  recording: consentRecordingInputSchema,
});
export type ConsentCreateInput = z.infer<typeof consentCreateInputSchema>;

/**
 * Body of `POST /v1/salud/consents/:id/sign`. MVP1 has no upload endpoint
 * (`files/paths.ts` only), so the evidence fingerprint is supplied directly and
 * degrades to metadata instead of a stored object.
 */
export const consentSignInputSchema = z.object({
  evidenceSha256: z.string().regex(SHA256_RE, 'Expected a 64-character hex digest'),
  evidenceBucketKey: z.string().min(1).optional(),
  evidenceMime: z.string().min(1).optional(),
});
export type ConsentSignInput = z.infer<typeof consentSignInputSchema>;
