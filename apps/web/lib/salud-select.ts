// Client-side selectors over the Salud lists.
//
// Every Salud list endpoint answers the whole scope capped at 200 rows and has
// no filter parameter (`GET /v1/salud/episodes` takes none at all, and
// `appointments` only lists the agenda). The MVP1 decision is therefore
// explicit: the API paginates nothing, and the screens filter and paginate in
// the browser. These pure functions are that decision, in one place, so the
// agenda, the patient file and the patient list apply the same rule.
//
// They are also what the screens use to *explain* themselves: a filtered view
// always says how many of the visible rows it is showing.
import {
  APPOINTMENT_STATUSES,
  type AppointmentRecord,
  type EpisodeRecord,
  type InvoiceRecord,
} from '@rizoma/contracts';
import { utcDateOf } from './salud-time.ts';

/** Rows per page of the patient list and the agenda. */
export const PAGE_SIZE = 10;

/** Role-shaped agenda view: who schedules, who cares, who only reads. */
export type AgendaView = 'recepcion' | 'medico' | 'lectura';

/**
 * Agenda view for a role. Reception schedules (`appointment.write`), the
 * physician reads their own day, and every other role that holds `agenda.read`
 * gets the read-only scope view.
 */
export function agendaViewFor(role: string | null | undefined): AgendaView {
  if (role === 'recepcion') return 'recepcion';
  if (role === 'medico') return 'medico';
  return 'lectura';
}

/** One page of rows plus the counters a paginator renders. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  /** 1-based index of the first row, or 0 when there are no rows. */
  readonly from: number;
  readonly to: number;
}

/** Clamps `page` into range and slices one page out of `items`. */
export function paginate<T>(items: readonly T[], page: number, size: number = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(page, 1), pageCount);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: current,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}

/** Episodes of one patient, newest first (the API order is `opened_at DESC`). */
export function episodesOfPatient(
  episodes: readonly EpisodeRecord[],
  patientId: string,
): readonly EpisodeRecord[] {
  return episodes.filter((episode) => episode.patientId === patientId);
}

/** Appointments of one patient, keeping the API order (`starts_at DESC`). */
export function appointmentsOfPatient(
  appointments: readonly AppointmentRecord[],
  patientId: string,
): readonly AppointmentRecord[] {
  return appointments.filter((appointment) => appointment.patientId === patientId);
}

/** Appointments of one professional, for the physician agenda view. */
export function appointmentsOfProfessional(
  appointments: readonly AppointmentRecord[],
  professionalId: string | null,
): readonly AppointmentRecord[] {
  if (professionalId === null || professionalId === '') return appointments;
  return appointments.filter((appointment) => appointment.professionalId === professionalId);
}

/** Appointments whose UTC day equals `date`, in start order. */
export function appointmentsOnUtcDate(
  appointments: readonly AppointmentRecord[],
  date: string,
): readonly AppointmentRecord[] {
  return appointments
    .filter((appointment) => utcDateOf(appointment.startsAt) === date)
    .sort((left, right) => (left.startsAt ?? '').localeCompare(right.startsAt ?? ''));
}

/** Split of a day into the states the agenda legend renders. */
export function statusCounts(
  appointments: readonly AppointmentRecord[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const status of APPOINTMENT_STATUSES) counts[status] = 0;
  for (const appointment of appointments) {
    const status = appointment.status === '' ? 'scheduled' : appointment.status;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** Distinct UTC days present in a list, ascending. */
export function utcDaysOf(appointments: readonly AppointmentRecord[]): readonly string[] {
  const days = new Set<string>();
  for (const appointment of appointments) {
    const day = utcDateOf(appointment.startsAt);
    if (day !== null) days.add(day);
  }
  return [...days].sort();
}

/**
 * Replaces an invoice in a session-local list by id, or prepends it.
 *
 * The caja screen keeps the documents it issued in this session because MVP1 has
 * no invoice *list* endpoint (`GET /v1/billing/invoices/:id` is the only read of
 * the resource). A pay or a void answers with the updated invoice, so the row is
 * replaced in place; a fresh issue has no row yet and goes on top.
 */
export function mergeInvoice(
  invoices: readonly InvoiceRecord[],
  invoice: InvoiceRecord,
): readonly InvoiceRecord[] {
  const known = invoices.some((row) => row.id === invoice.id);
  if (!known) return [invoice, ...invoices];
  return invoices.map((row) => (row.id === invoice.id ? invoice : row));
}
