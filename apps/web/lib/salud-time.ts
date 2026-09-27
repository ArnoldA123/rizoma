// UTC date/time helpers for the Salud agenda.
//
// The API stores `timestamptz` and `date`, and every dashboard query takes a
// `YYYY-MM-DD` day. The web therefore works in UTC end to end: the day filter,
// the day navigation and the labels all use UTC, so a browser in `America/Lima`
// and one in `Europe/Madrid` group the same appointment into the same day and
// the screen agrees with `GET /v1/salud/dashboards/:role?date=`.
//
// What UTC does *not* change: the scheduling form has to accept a wall-clock
// time. `datetime-local` values are interpreted as the browser's local time and
// converted once, here, into the offset-aware instant the API expects.
//
// The module is pure and dependency-free so it stays usable from a Client
// Component and readable in review.
import { isRealUtcDate, normalizeOrgTimezone } from '@rizoma/contracts';
import type { OrgNodeRecord } from '@rizoma/contracts';

/** Locale used for the day and time labels of the demo. */
const LOCALE = 'es-PE';

/**
 * Fallback sede zone (P4-1b): every "today" on screen is the day of the
 * sede, and a sede with no usable zone reads as Lima. Mirrors
 * `DEFAULT_ORG_TIMEZONE` from `@rizoma/contracts`.
 */
export const SEDE_FALLBACK_TIMEZONE = 'America/Lima';

/**
 * Usable IANA zone of a sede, or the Lima fallback. The sede travels as a
 * parameter: callers resolve it with `listOrgNodes` and land here when the
 * row is missing or the read failed.
 */
export function normalizeSedeTimezone(value: unknown): string {
  const zone = normalizeOrgTimezone(value);
  return zone === '' ? SEDE_FALLBACK_TIMEZONE : zone;
}

/**
 * Zone of the preferred sede node, or of the first node when the preferred
 * one is absent, or the Lima fallback when there are no nodes at all.
 * Components resolve the sede this way after `listOrgNodes`.
 */
export function resolveSedeTimezone(
  nodes: readonly OrgNodeRecord[],
  preferredId?: string | null,
): string {
  if (preferredId !== undefined && preferredId !== null && preferredId !== '') {
    const match = nodes.find((row) => row.id === preferredId);
    if (match !== undefined) return normalizeSedeTimezone(match.timezone);
  }
  const first = nodes[0];
  if (first === undefined) return SEDE_FALLBACK_TIMEZONE;
  return normalizeSedeTimezone(first.timezone);
}

/** Zone every sede helper formats in: the given zone, or Lima when unusable. */
function sedeZone(timezone?: string | null): string {
  return normalizeSedeTimezone(timezone ?? SEDE_FALLBACK_TIMEZONE);
}

/** Formatter bound to one zone, so a bad zone never throws at render time. */
function sedeFormatter(
  timezone: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: sedeZone(timezone) });
}

/**
 * `YYYY-MM-DD` of an ISO instant, read in the sede zone. `2026-09-26T04:30Z`
 * is still 25 September in Lima, while the UTC grouping reads the 26th.
 * `null` in, `null` out; `null` for an unreadable instant or zone.
 */
export function sedeDateOf(iso: string | null | undefined, timezone?: string | null): string | null {
  const date = toDate(iso);
  if (date === null) return null;
  try {
    const parts = sedeFormatter(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .sort((left, right) => partOrder(left.type) - partOrder(right.type));
    if (parts.length !== 3) return null;
    return parts.map((part) => part.value).join('-');
  } catch {
    return null;
  }
}

/** `HH:mm` of an ISO instant, read in the sede zone. */
export function sedeTimeOf(iso: string | null | undefined, timezone?: string | null): string {
  const date = toDate(iso);
  if (date === null) return '—';
  try {
    return sedeFormatter(timezone, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  } catch {
    return '—';
  }
}

/** `HH:mm–HH:mm` span of an appointment, in the sede zone. */
export function sedeTimeRange(
  startsAt: string | null,
  durationMin: number,
  timezone?: string | null,
): string {
  const date = toDate(startsAt);
  if (date === null) return '—';
  return `${sedeTimeOf(startsAt, timezone)}–${sedeTimeOf(new Date(date.getTime() + durationMin * 60_000).toISOString(), timezone)}`;
}

/** Today, as the sede day the screens group by. */
export function currentSedeDate(timezone?: string | null, now: Date = new Date()): string {
  return sedeDateOf(now.toISOString(), timezone) ?? currentUtcDate(now);
}

/** `true` when the day is today in the sede zone (used for the Hoy button). */
export function isCurrentSedeDate(
  date: string,
  timezone?: string | null,
  now: Date = new Date(),
): boolean {
  return date === currentSedeDate(timezone, now);
}

/**
 * `25 sep 2026 11:05` — a timestamp in the sede zone, or `—` when absent.
 * No zone suffix: the hour on screen is always the sede's.
 */
export function formatSedeStamp(iso: string | null | undefined, timezone?: string | null): string {
  const date = toDate(iso);
  if (date === null) return '—';
  try {
    return sedeFormatter(timezone, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return '—';
  }
}

/** Sort weight of a date part, so `formatToParts` always joins `YYYY-MM-DD`. */
function partOrder(type: Intl.DateTimeFormatPartTypes): number {
  if (type === 'year') return 0;
  if (type === 'month') return 1;
  if (type === 'day') return 2;
  return 3;
}

/** `YYYY-MM-DD` of an ISO instant, read in UTC. `null` in, `null` out. */
export function utcDateOf(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** `HH:mm` of an ISO instant, read in UTC. */
export function utcTimeOf(iso: string | null | undefined): string {
  const date = toDate(iso);
  if (date === null) return '—';
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** `HH:mm–HH:mm` span of an appointment, in UTC. */
export function utcTimeRange(startsAt: string | null, durationMin: number): string {
  const date = toDate(startsAt);
  if (date === null) return '—';
  return `${utcTimeOf(startsAt)}–${utcTimeOf(new Date(date.getTime() + durationMin * 60_000).toISOString())}`;
}

/** `25 sep 2026` for a `YYYY-MM-DD` day, or `—` when it is not a real day. */
export function formatUtcDate(date: string): string {
  if (!isRealUtcDate(date)) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** `jueves 25 de septiembre` for a day heading, or `—`. */
export function formatUtcDateLong(date: string): string {
  if (!isRealUtcDate(date)) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00.000Z`));
}

/** Moves a `YYYY-MM-DD` day by whole days, staying in UTC. */
export function shiftUtcDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return date;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Today, as the UTC day the agenda groups by. */
export function currentUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `true` when the day is today in UTC (used to label the day navigation). */
export function isCurrentUtcDate(date: string, now: Date = new Date()): boolean {
  return date === currentUtcDate(now);
}

/**
 * Converts a `datetime-local` value (browser-local wall clock) into the
 * offset-aware ISO instant the API stores. Returns `null` for anything that is
 * not a parseable value, so the caller keeps its validation verdict.
 */
export function dateTimeLocalToUtcIso(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Offset-aware instant for a UTC day plus a local time, used to seed the
 * scheduling form with the next round hour of the selected day.
 */
export function utcDayTimeToInstant(date: string, localTime: string): string | null {
  if (!isRealUtcDate(date) || !/^\d{2}:\d{2}$/.test(localTime)) return null;
  const [hours, minutes] = localTime.split(':');
  const date_ = new Date(`${date}T${hours}:${minutes}:00.000Z`);
  if (Number.isNaN(date_.getTime())) return null;
  return date_.toISOString();
}

/** Seconds elapsed, rendered as `hace 12 s` / `hace 3 min` / `hace 2 h`. */
export function formatElapsed(seconds: number): string {
  if (seconds < 5) return 'recién';
  if (seconds < 60) return `hace ${Math.round(seconds)} s`;
  if (seconds < 3_600) return `hace ${Math.round(seconds / 60)} min`;
  return `hace ${Math.round(seconds / 3_600)} h`;
}

/** `true` when the appointment starts before now (used for the day's order). */
export function isPast(startsAt: string | null, now: Date = new Date()): boolean {
  const date = toDate(startsAt);
  return date === null ? false : date.getTime() < now.getTime();
}

function toDate(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
