'use client';

import { useCallback, useEffect, useState } from 'react';
import { APPOINTMENT_STATUSES, appointmentListSchema, type AppointmentRecord } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AppointmentForm } from '@/components/salud/appointment-form';
import { ViewSelector } from '@/components/views/view-selector';
import { EmptyState, FailurePanel } from '@/components/salud/states';
import { DEV_IDENTITY } from '@/lib/config';
import { requestJson } from '@/lib/api-client';
import { withSavedView } from '@/lib/views-api';
import {
  appointmentStatusLabel,
  appointmentStatusVariant,
  roleLabel,
} from '@/lib/labels';
import {
  agendaViewFor,
  appointmentsOfProfessional,
  appointmentsOnUtcDate,
  statusCounts,
  type AgendaView,
} from '@/lib/salud-select';
import {
  currentUtcDate,
  formatElapsed,
  formatUtcDateLong,
  isCurrentUtcDate,
  shiftUtcDate,
  utcTimeRange,
} from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * `/salud/agenda` — the day agenda, its per-role view and the scheduling form.
 *
 * The parts that carry a decision:
 *
 *   - **Polling, 2 minutes.** `GET /v1/salud/appointments` has no cache and no
 *     `?date=`, so the board reads the scope once, filters the day in the browser
 *     and refreshes on a timer inside the 1–5 minute band the task sets. The
 *     timer pauses while the tab is hidden and refreshes once on return, so a
 *     background tab does not keep hitting the API, and the toolbar always states
 *     when the data was last read — a silent poll would make a stale day look
 *     current.
 *   - **Views by role, stated honestly.** Reception gets the day plus the
 *     scheduling form; the physician gets a *focus* on their own appointments;
 *     every other `agenda.read` role gets the scope view. The physician focus is
 *     labelled as a focus, not as an authorisation: the API returns the whole
 *     sede agenda to any `agenda.read` holder, so the UI must not imply that the
 *     endpoint hides other professionals' rows.
 *   - **Skeletons shaped like the row**, with the directional sweep, instead of a
 *     spinner: the day keeps its geometry while it loads.
 *   - **UTC everywhere.** The day filter, the navigation and the labels are UTC,
 *     which is what makes this screen agree with `?date=` on the dashboards.
 */
export interface AgendaBoardProps {
  readonly role: string | null;
  /** User id of the session, used by the physician focus. */
  readonly viewerId: string | null;
  /** `appointment.write` — only reception holds it. */
  readonly canWrite: boolean;
}

/** Refresh period of the board, inside the 1–5 minute band of the task. */
const POLL_MS = 120_000;

export function AgendaBoard({ role, viewerId, canWrite }: AgendaBoardProps) {
  const view: AgendaView = agendaViewFor(role);
  // The active saved view narrows the server agenda via `?saved_view_id=`; null
  // reads the unfiltered scope. The id joins the resource key so a pick
  // refetches (and the 2-minute poll keeps polling the narrowed list).
  const [savedViewId, setSavedViewId] = useState<string | null>(null);
  const appointments = useResource<AppointmentRecord[]>(
    `agenda:${savedViewId ?? ''}`,
    (signal) => readAgenda(savedViewId, signal),
  );
  const [day, setDay] = useState<string>(() => currentUtcDate());
  const [focusOwn, setFocusOwn] = useState(view === 'medico');
  const [formOpen, setFormOpen] = useState(view === 'recepcion');
  const [now, setNow] = useState(() => Date.now());

  const reload = appointments.reload;

  // Poll: a timer inside the band, paused while the tab is hidden, plus one
  // refresh on return so the day is never presented as current when it is not.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, POLL_MS);
    const onVisibility = (): void => {
      if (!document.hidden) reload();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reload]);

  // A slow ticker, only to age the "actualizado hace…" copy.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = appointments.data ?? [];
  const dayRows = appointmentsOnUtcDate(rows, day);
  const visible =
    focusOwn && view === 'medico' ? appointmentsOfProfessional(dayRows, viewerId) : dayRows;
  const counts = statusCounts(dayRows);
  const knownOrgNodeId = rows[0]?.orgNodeId ?? DEV_IDENTITY.orgNodeId;

  const handleCreated = useCallback(
    (appointment: AppointmentRecord) => {
      appointments.setData((current) => [appointment, ...(current ?? [])]);
    },
    [appointments],
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardEyebrow>Agenda · día UTC</CardEyebrow>
          <CardTitle as="h2" className="text-lg">
            {formatUtcDateLong(day)}
          </CardTitle>
          <CardDescription>
            Vista {viewLabel(view)} para {roleLabel(role)}. El filtro por día, la navegación y las
            etiquetas usan UTC; la hora de la cita se escribe en hora local y se convierte una sola
            vez al programarla.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <ViewSelector
            entity="appointments"
            selectedId={savedViewId}
            onSelect={setSavedViewId}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDay(shiftUtcDate(day, -1))}>
              Día anterior
            </Button>
            <Button
              variant={isCurrentUtcDate(day) ? 'ghost' : 'outline'}
              size="sm"
              onClick={() => setDay(currentUtcDate())}
              disabled={isCurrentUtcDate(day)}
            >
              Hoy (UTC)
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDay(shiftUtcDate(day, 1))}>
              Día siguiente
            </Button>

            <label htmlFor="agenda-day" className="sr-only">
              Día de la agenda
            </label>
            <Input
              id="agenda-day"
              type="date"
              className="w-40"
              value={day}
              onChange={(event) => {
                if (event.target.value !== '') setDay(event.target.value);
              }}
            />

            {view === 'medico' ? (
              <Button
                variant={focusOwn ? 'outline' : 'ghost'}
                size="sm"
                onClick={() => setFocusOwn((value) => !value)}
              >
                {focusOwn ? 'Ver toda la sede' : 'Ver solo mis citas'}
              </Button>
            ) : null}

            <div className="ml-auto flex flex-wrap items-center gap-3">
              <span className="tabular text-xs text-muted-foreground">
                {appointments.loading
                  ? 'leyendo…'
                  : appointments.loadedAt === null
                    ? 'sin lectura'
                    : `actualizado ${formatElapsed((now - appointments.loadedAt) / 1000)}`}
              </span>
              <Button variant="ghost" size="sm" onClick={reload} disabled={appointments.loading}>
                Actualizar
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <span className="text-xs text-muted-foreground">Estado del día:</span>
            {APPOINTMENT_STATUSES.map((status) => (
              <Badge key={status} variant={appointmentStatusVariant(status)}>
                {appointmentStatusLabel(status)}: {counts[status] ?? 0}
              </Badge>
            ))}
            <span className="tabular ml-auto text-[0.6875rem] text-muted-foreground">
              lectura automática cada 2 min · se pausa con la pestaña oculta
            </span>
          </div>

          {view === 'medico' ? (
            <p className="text-xs text-muted-foreground">
              El foco en sus citas es una decisión de interfaz: el API devuelve la agenda de la sede a
              todo rol con <code className="font-mono">agenda.read</code>, así que las demás filas
              siguen en el alcance y se muestran al desactivar el foco.
            </p>
          ) : null}

          {!appointments.loading && appointments.failure !== null ? (
            <FailurePanel
              title="No se pudo leer la agenda"
              failure={appointments.failure}
              onRetry={reload}
            />
          ) : null}

          {appointments.loading ? <AgendaSkeleton /> : null}

          {!appointments.loading && appointments.failure === null && visible.length === 0 ? (
            <EmptyState
              eyebrow="Sin citas"
              title={`Sin citas el ${day}`}
              description={
                focusOwn && view === 'medico'
                  ? 'No hay citas suyas ese día. Desactive el foco para ver el resto de la sede.'
                  : 'El API respondió con una lista válida: la agenda de ese día está vacía en el alcance actual.'
              }
            >
              {canWrite ? (
                <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
                  Programar una cita
                </Button>
              ) : null}
            </EmptyState>
          ) : null}

          {visible.length === 0 ? null : (
            <ul className="flex flex-col">
              {visible.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0"
                >
                  <div className="flex min-w-0 items-baseline gap-4">
                    <span className="tabular w-28 shrink-0 text-[0.9375rem] font-medium">
                      {utcTimeRange(appointment.startsAt, appointment.durationMin)}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[0.8125rem]">
                        {appointment.durationMin} min · paciente{' '}
                        <span className="font-mono text-xs">
                          {appointment.patientId.slice(0, 8)}…
                        </span>
                      </span>
                      <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                        profesional {appointment.professionalId.slice(0, 8)}… · sede{' '}
                        {appointment.orgNodeId.slice(0, 8)}…
                      </span>
                    </span>
                  </div>
                  <Badge variant={appointmentStatusVariant(appointment.status)}>
                    {appointmentStatusLabel(appointment.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canWrite ? (
        <div className="flex flex-col gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setFormOpen((open) => !open)}
          >
            {formOpen ? 'Ocultar formulario de cita' : 'Programar una cita'}
          </Button>
          {formOpen ? (
            <AppointmentForm day={day} defaultOrgNodeId={knownOrgNodeId} onCreated={handleCreated} />
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Su rol no tiene <code className="font-mono">appointment.write</code>: la agenda se muestra
          en modo lectura y el formulario de programación no está disponible.
        </p>
      )}
    </div>
  );
}

/**
 * Reads the scope agenda through the proxy, narrowed by the active saved view.
 * Day filtering stays in the browser: the API offers no `?date=`, so the board
 * keeps reading the scope (now optionally narrowed) and slicing the day locally.
 */
async function readAgenda(
  savedViewId: string | null,
  signal: AbortSignal,
): Promise<AppointmentRecord[]> {
  const rows = await requestJson(
    withSavedView('/salud/appointments', savedViewId),
    appointmentListSchema,
    { signal },
  );
  return rows ?? [];
}

function viewLabel(view: AgendaView): string {
  if (view === 'recepcion') return 'de recepción';
  if (view === 'medico') return 'del profesional';
  return 'de lectura';
}

/**
 * Loading state shaped like the rows that follow: a time column, two text lines
 * and the status pill. The sweep is directional (`sd-shimmer`), so the day reads
 * as "arriving" instead of "busy".
 */
function AgendaSkeleton() {
  return (
    <div aria-hidden className="flex flex-col">
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0"
        >
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-24" delay={index * 80} />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-40" delay={index * 80 + 60} />
              <Skeleton className="h-2.5 w-52" delay={index * 80 + 120} />
            </div>
          </div>
          <Skeleton className={cn('h-5 w-20 rounded-full')} delay={index * 80 + 180} />
        </div>
      ))}
    </div>
  );
}
