// Dashboard contracts — board shapes of `apps/api/src/salud/dashboards.service.ts`
// and `apps/api/src/obras/dashboards.service.ts` (bases-consolidadas-v1.md
// §6.2, §6.3).
//
// Every board is already filtered by the caller scope in the API, so the web
// renders KPIs as-is. The salud boards are split by role on purpose (§6.3): the
// caja board carries amounts and fiscal states only, never clinical data, and
// the medico board carries counts only, never amounts. That separation is a
// security property of the contract, not a presentation choice.
import { z } from 'zod';
import { isoDateSchema, uuidSchema } from './common.ts';
import type { SaludBoardQuery } from './salud.ts';

// ============ salud boards (§6.3) ============

/** Board roles the salud vertical exposes. */
export const DASHBOARD_ROLES = ['recepcion', 'caja', 'medico'] as const;
export const dashboardRoleSchema = z.enum(DASHBOARD_ROLES);
export type DashboardRole = z.infer<typeof dashboardRoleSchema>;

/** Fields every salud board carries. */
export const dashboardBaseSchema = z.object({
  role: dashboardRoleSchema,
  orgNodeId: uuidSchema,
  /** `YYYY-MM-DD` the KPIs were filtered on. */
  date: isoDateSchema,
});

/** §6.3 recepcion: today's appointments, waiting time, no-shows and queue. */
export const recepcionBoardSchema = dashboardBaseSchema.extend({
  role: z.literal('recepcion'),
  todayAppointments: z.number(),
  waitingAvgMin: z.number(),
  noShows: z.number(),
  queue: z.number(),
});

/** §6.3 caja: amounts and fiscal states only — never clinical data. */
export const cajaBoardSchema = dashboardBaseSchema.extend({
  role: z.literal('caja'),
  todayCollected: z.number(),
  invoicesIssued: z.number(),
  fiscalPending: z.number(),
  openSession: z
    .object({ id: uuidSchema, orgNodeId: uuidSchema, openedAt: z.string().nullable() })
    .nullable(),
});

/** §6.3 medico: own appointments, open episodes and pending consents. */
export const medicoBoardSchema = dashboardBaseSchema.extend({
  role: z.literal('medico'),
  myAppointments: z.number(),
  openEpisodes: z.number(),
  pendingConsents: z.number(),
});

/** `GET /v1/salud/dashboards/:role?org=&date=` — discriminated by `role`. */
export const saludDashboardBoardSchema = z.discriminatedUnion('role', [
  recepcionBoardSchema,
  cajaBoardSchema,
  medicoBoardSchema,
]);

export type RecepcionBoard = z.infer<typeof recepcionBoardSchema>;
export type CajaBoard = z.infer<typeof cajaBoardSchema>;
export type MedicoBoard = z.infer<typeof medicoBoardSchema>;
export type SaludDashboardBoard = z.infer<typeof saludDashboardBoardSchema>;

// ============ board read path (§6.3) ============

/**
 * Refresh band of the role boards. The consolidated bases put the dashboard
 * cache at 5–15 minutes on a read replica; MVP1 has neither a replica nor a
 * Redis, so the web polls instead, and it does so inside this band: fast enough
 * to see a new invoice, slow enough not to hammer a primary connection.
 */
export const BOARD_POLL_MIN_MS = 60_000;
export const BOARD_POLL_MAX_MS = 300_000;
/** Period the screens start with, in the middle of the band. */
export const BOARD_POLL_DEFAULT_MS = 180_000;

/** Clamps a requested period into the band; non-finite values fall back. */
export function clampBoardPollMs(value: number): number {
  if (!Number.isFinite(value)) return BOARD_POLL_DEFAULT_MS;
  return Math.min(BOARD_POLL_MAX_MS, Math.max(BOARD_POLL_MIN_MS, Math.round(value)));
}

/**
 * Board the caller may open. The API requires the requested board role to be
 * the caller's own membership role (`rolePermits = role === membership.role`),
 * so any other combination is a 403 `role.denied` the UI refuses to request.
 * Returns `null` for a role that has no board at all.
 */
export function boardRoleFor(role: string | null | undefined): DashboardRole | null {
  if (role === null || role === undefined) return null;
  return (DASHBOARD_ROLES as readonly string[]).includes(role) ? (role as DashboardRole) : null;
}

/**
 * Query string of `GET /v1/salud/dashboards/:role`, `?` included and empty
 * fields omitted (`org` then `date`, the order the service reads them). The API
 * defaults `org` to the membership node and `date` to today in UTC, so an
 * omitted field is a request for the default, never an error.
 */
export function saludBoardQueryString(query: SaludBoardQuery = {}): string {
  const parts: string[] = [];
  if (query.org !== undefined && query.org !== '') parts.push(`org=${encodeURIComponent(query.org)}`);
  if (query.date !== undefined && query.date !== '')
    parts.push(`date=${encodeURIComponent(query.date)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

// ============ obras boards (§6.2) ============

/** Avance of one budget line over its posted progress entries. */
export const progressLineBoardSchema = z.object({
  budgetLineId: uuidSchema,
  description: z.string(),
  qtyPlanned: z.number(),
  qtyDone: z.number(),
  /** Never negative: an over-delivered line reports 0 remaining. */
  qtyRemaining: z.number(),
  percent: z.number(),
});

/** Attendance of one day, counted per `attendance.status`. */
export const attendanceDayBoardSchema = z.object({
  date: isoDateSchema,
  registered: z.number(),
  approved: z.number(),
  rejected: z.number(),
  adjusted: z.number(),
  total: z.number(),
});

/** One inventory item whose posted stock sits under its `min_stock`. */
export const criticalStockBoardSchema = z.object({
  itemId: uuidSchema,
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  minStock: z.number(),
  available: z.number(),
});

/** One equipment unit currently in `maintenance`. */
export const maintenanceAssetBoardSchema = z.object({
  assetId: uuidSchema,
  code: z.string(),
  kind: z.string(),
  serial: z.string(),
});

/** One milestone that is not done and is due within the horizon. */
export const upcomingMilestoneBoardSchema = z.object({
  milestoneId: uuidSchema,
  name: z.string(),
  dueAt: z.string().nullable(),
  status: z.string(),
});

/** `GET /v1/obras/sites/:siteId/board?date=` — the site board (§6.2). */
export const siteBoardSchema = z.object({
  siteId: uuidSchema,
  siteCode: z.string(),
  orgNodeId: uuidSchema,
  date: isoDateSchema,
  progress: z.array(progressLineBoardSchema),
  attendance: attendanceDayBoardSchema,
  criticalStock: z.array(criticalStockBoardSchema),
  maintenanceAssets: z.array(maintenanceAssetBoardSchema),
  upcomingMilestones: z.array(upcomingMilestoneBoardSchema),
});

/** KPIs that do not apply at company scope, stated instead of reported as 0. */
export const companyBoardNotApplicableSchema = z.object({
  collections: z.string(),
  moduleUsage: z.string(),
});

/** `GET /v1/obras/board` — the company board over the caller scope. */
export const companyBoardSchema = z.object({
  orgNodeId: uuidSchema,
  date: isoDateSchema,
  sites: z.object({
    total: z.number(),
    active: z.number(),
    planned: z.number(),
    closed: z.number(),
  }),
  progress: z.object({
    qtyPlanned: z.number(),
    qtyDone: z.number(),
    qtyRemaining: z.number(),
    percent: z.number(),
  }),
  notApplicable: companyBoardNotApplicableSchema,
});

export type ProgressLineBoard = z.infer<typeof progressLineBoardSchema>;
export type AttendanceDayBoard = z.infer<typeof attendanceDayBoardSchema>;
export type CriticalStockBoard = z.infer<typeof criticalStockBoardSchema>;
export type MaintenanceAssetBoard = z.infer<typeof maintenanceAssetBoardSchema>;
export type UpcomingMilestoneBoard = z.infer<typeof upcomingMilestoneBoardSchema>;
export type SiteBoard = z.infer<typeof siteBoardSchema>;
export type CompanyBoardNotApplicable = z.infer<typeof companyBoardNotApplicableSchema>;
export type CompanyBoard = z.infer<typeof companyBoardSchema>;

// ============ obras board read path (W4) ============

/**
 * Refresh band of the obras boards. The consolidated bases put the construction
 * dashboards at a 5–15 minute cadence, slower than the salud role boards on
 * purpose: a site board aggregates progress, stock and milestones, and the
 * operational day does not move as fast as a reception queue.
 */
export const OBRAS_BOARD_POLL_MIN_MS = 300_000;
export const OBRAS_BOARD_POLL_MAX_MS = 900_000;
/** Period the screens start with, in the middle of the band. */
export const OBRAS_BOARD_POLL_DEFAULT_MS = 600_000;

/** Clamps a requested period into the obras band; non-finite values fall back. */
export function clampObrasBoardPollMs(value: number): number {
  if (!Number.isFinite(value)) return OBRAS_BOARD_POLL_DEFAULT_MS;
  return Math.min(OBRAS_BOARD_POLL_MAX_MS, Math.max(OBRAS_BOARD_POLL_MIN_MS, Math.round(value)));
}

/** Query of `GET /v1/obras/sites/:siteId/board`. */
export interface SiteBoardQuery {
  /** `YYYY-MM-DD`; omitted asks the API for today in UTC. */
  readonly date?: string;
}

/**
 * Query string of `GET /v1/obras/sites/:siteId/board`, `?` included and an empty
 * `date` omitted. The service defaults an absent `date` to today in UTC and
 * echoes the day it used, so an omitted field is a request for the default and
 * never an error.
 */
export function siteBoardQueryString(query: SiteBoardQuery = {}): string {
  if (query.date === undefined || query.date === '') return '';
  return `?date=${encodeURIComponent(query.date)}`;
}
