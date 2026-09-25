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
import { isRealUtcDate } from '@rizoma/contracts';

/** Locale used for the day and time labels of the demo. */
const LOCALE = 'es-PE';

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
