// Obras contracts — row shapes of `apps/api/src/obras/obras.service.ts`
// (bases-consolidadas-v1.md §2.4, §3.4, §6.2).
//
// The access key of this vertical is the *assignment*, not the role: a
// `trabajador` reaches only the site they are actively assigned to, while
// `gerente` / `jefe_obra` are org-scoped (`ORG_SCOPED_SITE_ROLES` in the
// service). Those rules live in the API; this module only mirrors the shapes.
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';

/** `GET/POST /v1/obras/sites` — one construction site. */
export const siteRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  orgNodeId: uuidSchema,
  code: z.string(),
  name: z.string(),
  clientName: z.string(),
  budgetTotal: z.number(),
  startedAt: isoValueSchema,
  endedAt: isoValueSchema,
  /** `planned` / `active` / `closed`. */
  status: z.string(),
});

export type SiteRecord = z.infer<typeof siteRecordSchema>;

/** `GET /v1/obras/sites` — the API caps every list at 200 rows. */
export const siteListSchema = z.array(siteRecordSchema);
export type SiteList = z.infer<typeof siteListSchema>;

/** `POST /v1/obras/sites/:siteId/staff` — one worker assignment. */
export const assignmentRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  userId: uuidSchema,
  siteId: uuidSchema,
  crewId: isoValueSchema,
  roleInSite: z.string(),
  active: z.boolean(),
  validFrom: isoValueSchema,
  validTo: isoValueSchema,
});

export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;

/** `GET /v1/obras/sites/:siteId/staff` — assignment joined with worker names. */
export const siteStaffRecordSchema = assignmentRecordSchema.extend({
  userName: z.string(),
  crewName: isoValueSchema,
});

export type SiteStaffRecord = z.infer<typeof siteStaffRecordSchema>;

/** `GET /v1/obras/sites/:siteId/staff` — active assignments only. */
export const siteStaffListSchema = z.array(siteStaffRecordSchema);
export type SiteStaffList = z.infer<typeof siteStaffListSchema>;

/** `GET/POST /v1/obras/attendance` — one attendance mark. */
export const attendanceRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  userId: uuidSchema,
  siteId: uuidSchema,
  checkIn: isoValueSchema,
  checkOut: isoValueSchema,
  source: z.string(),
  /** `registered` / `approved` / `rejected` / `adjusted`. */
  status: z.string(),
  approvedBy: isoValueSchema,
});

export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;

/** `GET /v1/obras/attendance?site=&date=` — marks of one day at one site. */
export const attendanceListSchema = z.array(attendanceRecordSchema);
export type AttendanceList = z.infer<typeof attendanceListSchema>;

/** Roles whose site visibility is bounded by the org subtree, not assignment. */
export const ORG_SCOPED_SITE_ROLES = ['gerente', 'jefe_obra'] as const;

export type OrgScopedSiteRole = (typeof ORG_SCOPED_SITE_ROLES)[number];

// ============ request bodies (W4) ============
//
// Field-for-field mirrors of the service parsers (`parseSiteCreate`,
// `parseAssignmentCreate`, `parseAttendanceMark`). The defaults are part of the
// mirror on purpose: the API applies `budgetTotal = 0`, `status = 'planned'` and
// `source = 'web'` when the field is absent, so a form that omits them produces
// exactly the row the service would.

/** `sites.status` — the CHECK of `005_obras.sql`, in the API's own order. */
export const SITE_STATUSES = [
  'planned',
  'active',
  'suspended',
  'closing',
  'closed',
  'cancelled',
] as const;

export const siteStatusSchema = z.enum(SITE_STATUSES);
export type SiteStatus = z.infer<typeof siteStatusSchema>;

/** `attendance.status` — `registered` is the only state a worker creates. */
export const ATTENDANCE_STATUSES = ['registered', 'approved', 'rejected', 'adjusted'] as const;

export const attendanceStatusSchema = z.enum(ATTENDANCE_STATUSES);
export type AttendanceStatus = z.infer<typeof attendanceStatusSchema>;

/** UI caps for the site form; the API itself only requires a non-empty text. */
export const SITE_CODE_MAX = 24;
export const SITE_NAME_MAX = 120;
export const SITE_CLIENT_NAME_MAX = 120;
/** `assignments.role_in_site` is a free label, not a realm role. */
export const SITE_ROLE_MAX = 60;

/** Body of `POST /v1/obras/sites` (`site.write`, gerente only). */
export const siteCreateInputSchema = z.object({
  orgNodeId: uuidSchema,
  code: z.string().min(1),
  name: z.string().min(1),
  clientName: z.string().min(1),
  /** Non-negative; the API refuses a negative or non-finite value. */
  budgetTotal: z.number().nonnegative().default(0),
  status: siteStatusSchema.default('planned'),
});

export type SiteCreateInput = z.input<typeof siteCreateInputSchema>;

/** Body of `POST /v1/obras/sites/:siteId/staff` (`assignment.write`). */
export const assignmentCreateInputSchema = z.object({
  userId: uuidSchema,
  /** Crew the worker joins, or `null` when the site has no crew yet. */
  crewId: uuidSchema.nullable().default(null),
  roleInSite: z.string().min(1),
});

export type AssignmentCreateInput = z.input<typeof assignmentCreateInputSchema>;

/**
 * Body of `POST /v1/obras/attendance` — the caller's own mark.
 *
 * `userId` is omitted by every UI flow on purpose: the service rejects a
 * `userId` that is not the token subject with `obra.access_denied`, so the
 * honest client never sends one. It stays in the contract because the endpoint
 * accepts it and the mirror has to describe the endpoint, not just the screen.
 */
export const attendanceMarkInputSchema = z.object({
  siteId: uuidSchema,
  userId: uuidSchema.optional(),
  source: z.string().min(1).default('web'),
});

export type AttendanceMarkInput = z.input<typeof attendanceMarkInputSchema>;

// ============ read-path query helpers (W4) ============

/** Query of `GET /v1/obras/attendance` — both fields are required by the API. */
export interface AttendanceQuery {
  readonly site?: string;
  readonly date?: string;
}

/**
 * Query string of `GET /v1/obras/attendance`, `?` included and empty fields
 * omitted (`site` then `date`, the order the controller reads them). The service
 * rejects a missing or malformed `date`, so an empty field here is a *missing*
 * parameter and never a default: the screen must supply both.
 */
export function attendanceQueryString(query: AttendanceQuery = {}): string {
  const parts: string[] = [];
  if (query.site !== undefined && query.site !== '')
    parts.push(`site=${encodeURIComponent(query.site)}`);
  if (query.date !== undefined && query.date !== '')
    parts.push(`date=${encodeURIComponent(query.date)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}
