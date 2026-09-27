// Release sweep runtime — frees never-confirmed agenda slots (P4-3b).
//
// Production counterpart of `releaseUnconfirmedAppointments` in
// `apps/api/src/salud/salud.service.ts` (the desk-triggered use case): this
// module runs on the workers host on a 15-minute repeatable, across every
// tenant, with the system as actor. Every `scheduled` appointment whose
// `starts_at` already passed moves to `cancelled` with one
// `appointment.released` audit row each (the diff carries
// `reason: 'unconfirmed_window_passed'` plus the missed start, so the trail
// distinguishes a release from a desk cancellation — same shape as the API
// use case, minus the request trace id the workers do not have).
//
// The `pg` pool is injected (`ReleaseSweepClient`) — this module never
// imports `pg` — and BullMQ stays out too: the caller passes an optional
// `cancelReminder` handle so a released visit also drops its deferred 24h
// job. The fire-time guard would skip it anyway; removal just keeps the
// queue clean. Every row is best-effort: one bad row never aborts the sweep.

/** Queue the repeatable release job lives on (owned by the workers host). */
export const RELEASE_SWEEP_QUEUE = 'release-sweep';

/** Name of the repeatable release job (single recurring job). */
export const RELEASE_SWEEP_JOB_NAME = 'release-sweep';

/** Cadence of the release sweep: every 15 minutes. */
export const RELEASE_SWEEP_EVERY_MS = 15 * 60 * 1000;

/** Largest batch one sweep pass releases; keeps a stray wide scan bounded. */
export const RELEASE_SWEEP_BATCH_LIMIT = 200;

/** Actor recorded on the release audit rows (no human desk involved). */
export const RELEASE_SWEEP_ACTOR = 'system';

/**
 * Candidates of one sweep pass: every `scheduled` appointment whose start
 * already passed, oldest first. Global (no tenant filter): the workers host
 * serves every tenant and each update below re-scopes by `tenant_id`.
 */
export const SELECT_DUE_UNCONFIRMED_SQL = `SELECT id, tenant_id, org_node_id, starts_at
FROM appointments
WHERE status = 'scheduled' AND starts_at < $1
ORDER BY starts_at ASC LIMIT $2`;

/**
 * Releases one candidate. The `status = 'scheduled'` re-check makes the
 * release lose against a concurrent desk confirm: when the desk won the
 * race the update matches no row and the sweep skips it.
 */
export const CANCEL_RELEASED_SQL = `UPDATE appointments
SET status = 'cancelled'
WHERE tenant_id = $1 AND id = $2 AND status = 'scheduled'
RETURNING id, tenant_id, org_node_id, starts_at`;

/** One `appointment.released` audit row per released visit. */
export const INSERT_RELEASE_AUDIT_SQL = `INSERT INTO audit_log
  (tenant_id, actor, action, entity, entity_id, org_node_id, diff, ip)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`;

/** Minimal SQL surface the sweep needs (pool or client; `pg` is injected). */
export interface ReleaseSweepClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

/** One released visit. */
export interface ReleasedAppointment {
  readonly id: string;
  readonly tenantId: string;
  readonly orgNodeId: string;
  /** The missed start (`starts_at` as stored). */
  readonly startsAt: string | null;
}

/** Outcome of one sweep pass. */
export interface ReleaseSweepResult {
  /** Visits actually released (cancelled + audited) by this pass. */
  readonly released: ReleasedAppointment[];
  /** Candidates the pass examined (releases can be fewer after races). */
  readonly checked: number;
}

/** Options of one sweep pass (all optional). */
export interface ReleaseSweepOptions {
  /** Clock override for deterministic sweeps under test. */
  readonly nowMs?: number;
  /** Largest batch this pass releases (defaults to `RELEASE_SWEEP_BATCH_LIMIT`). */
  readonly limit?: number;
  /**
   * Deferred-job cleanup: drops the 24h reminder job of a released visit.
   * Best-effort per visit — a rejection never fails the release.
   */
  readonly cancelReminder?: (appointmentId: string) => Promise<void>;
}

/** Narrows an opaque `pg` result to its rows without importing `pg` types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

/** `timestamptz` may arrive as `Date` or string; normalize or null. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Runs one release pass: cancels every past `scheduled` appointment and
 * audits each release as the system actor. Never throws for row-level
 * failures — a bad row is skipped and the sweep continues; only a failed
 * candidate SELECT (the database is unreachable) propagates, so the caller
 * (repeatable job) records the pass as failed and retries on cadence.
 */
export async function runReleaseSweep(
  client: ReleaseSweepClient,
  options: ReleaseSweepOptions = {},
): Promise<ReleaseSweepResult> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? RELEASE_SWEEP_BATCH_LIMIT;
  const cutoff = new Date(nowMs).toISOString();
  const found = await client.query(SELECT_DUE_UNCONFIRMED_SQL, [cutoff, limit]);
  const released: ReleasedAppointment[] = [];
  let checked = 0;
  for (const candidate of readRows(found)) {
    checked += 1;
    const tenantId = readString(candidate.tenant_id);
    const id = readString(candidate.id);
    const orgNodeId = readString(candidate.org_node_id);
    if (tenantId === undefined || id === undefined || orgNodeId === undefined) continue;
    let updated: unknown;
    try {
      updated = await client.query(CANCEL_RELEASED_SQL, [tenantId, id]);
    } catch {
      continue;
    }
    const row = readRows(updated)[0];
    if (row === undefined) continue;
    const startsAt = toIso(row.starts_at ?? candidate.starts_at);
    try {
      await client.query(INSERT_RELEASE_AUDIT_SQL, [
        tenantId,
        RELEASE_SWEEP_ACTOR,
        'appointment.released',
        'appointment',
        id,
        orgNodeId,
        JSON.stringify({
          from: 'scheduled',
          to: 'cancelled',
          reason: 'unconfirmed_window_passed',
          startsAt,
        }),
        null,
      ]);
    } catch {
      continue;
    }
    if (options.cancelReminder !== undefined) {
      try {
        await options.cancelReminder(id);
      } catch {
        // Best-effort: the release already committed; the fire-time guard
        // would skip the leftover job anyway.
      }
    }
    released.push({ id, tenantId, orgNodeId, startsAt });
  }
  return { released, checked };
}
