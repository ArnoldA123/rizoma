'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AppointmentRecord } from '@rizoma/contracts';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { SkeletonRows } from '@/components/ui/skeleton';
import { IconArrowRight } from '@/components/ui/icons';
import { EmptyState, FailurePanel } from '@/components/salud/states';
import { appointmentStatusLabel } from '@/lib/labels';
import { getSaludBoard, listAppointments, listPatients } from '@/lib/salud-api';
import { listUsers } from '@/lib/users-api';
import { listOrgNodes } from '@/lib/org-api';
import type { OrgNodeRecord } from '@rizoma/contracts';
import { appointmentsOnSedeDate } from '@/lib/salud-select';
import { currentSedeDate, formatUtcDateLong, resolveSedeTimezone, sedeTimeRange } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import type { HomeLink } from './role-home';

export interface RecepcionDayProps {
  readonly links: readonly HomeLink[];
}

/**
 * Day cover of the recepción role (P3-1a).
 *
 * Counts come from the recepción board (`todayAppointments`, `waitingAvgMin`,
 * `noShows`, `queue`); the rows below are the whole sede queue of today in
 * the sede zone, with patient and professional names resolved against the
 * scope lists. No identifier is rendered — names own the rows.
 */
export function RecepcionDay({ links }: RecepcionDayProps) {
  const board = useResource('home-board:recepcion', (signal) =>
    getSaludBoard('recepcion', {}, signal),
  );
  const agenda = useResource('home-agenda:recepcion', (signal) => listAppointments(signal));
  const [patientNames, setPatientNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [userNames, setUserNames] = useState<ReadonlyMap<string, string>>(new Map());
  // The sede travels as a parameter: zone of the first agenda sede from the
  // org tree, Lima fallback while the list loads or when the row has no zone.
  const [sedeNodes, setSedeNodes] = useState<readonly OrgNodeRecord[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listOrgNodes({ kind: 'sede' }, controller.signal)
      .then((nodes) => {
        if (active) setSedeNodes(nodes);
      })
      .catch(() => {
        if (active) setSedeNodes([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const agendaRows = agenda.data ?? [];
  const boardOrg =
    board.data !== null && board.data.role === 'recepcion' ? board.data.orgNodeId : null;
  const sedeTimezone = resolveSedeTimezone(sedeNodes, agendaRows[0]?.orgNodeId ?? boardOrg);
  const today = currentSedeDate(sedeTimezone);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const signal = controller.signal;
    Promise.allSettled([listPatients(signal), listUsers({}, signal)]).then(([patients, users]) => {
      if (!active) return;
      if (patients.status === 'fulfilled') {
        setPatientNames(new Map(patients.value.map((row) => [row.id, row.personName])));
      }
      if (users.status === 'fulfilled') {
        setUserNames(new Map(users.value.map((row) => [row.id, row.name])));
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const recepcionBoard =
    board.data !== null && board.data.role === 'recepcion' ? board.data : null;
  const dayRows = appointmentsOnSedeDate(agendaRows, today, sedeTimezone);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Recepción · hoy"
        title="La cola de hoy"
        description={`${formatUtcDateLong(today)}: citas del día, espera promedio, inasistencias y cola, con nombre y hora por fila.`}
        action={
          <Link href="/salud/tableros/recepcion" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Abrir mi tablero
          </Link>
        }
      />

      {board.failure !== null ? (
        <FailurePanel title="No se pudo leer su día" failure={board.failure} onRetry={board.reload} />
      ) : null}

      {board.loading && recepcionBoard === null ? (
        <SkeletonRows rows={4} />
      ) : recepcionBoard === null ? null : (
        <div className="grid gap-4 sm:grid-cols-4">
          <DayCount label="Citas de hoy" value={String(recepcionBoard.todayAppointments)} hint="En la sede" />
          <DayCount label="Espera promedio" value={`${recepcionBoard.waitingAvgMin} min`} hint="Con un decimal" />
          <DayCount label="Inasistencias" value={String(recepcionBoard.noShows)} hint="No asistió" />
          <DayCount label="Cola" value={String(recepcionBoard.queue)} hint="En espera" />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardEyebrow>Cola de hoy</CardEyebrow>
          <CardTitle as="h2">Citas del día en la sede</CardTitle>
          <CardDescription>
            Toda la cola de hoy, ordenada por hora de inicio. Programar una cita se hace desde la
            pantalla de agenda.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {agenda.loading && dayRows.length === 0 ? <SkeletonRows rows={3} /> : null}
          {!agenda.loading && agenda.failure !== null ? (
            <FailurePanel
              title="No se pudo leer la cola"
              failure={agenda.failure}
              onRetry={agenda.reload}
            />
          ) : null}
          {!agenda.loading && agenda.failure === null && dayRows.length === 0 ? (
            <EmptyState
              eyebrow="Sin citas"
              title="La cola de hoy está vacía"
              description="El API respondió con una lista válida: hoy no hay citas en la sede en el alcance actual."
            />
          ) : null}
          {dayRows.length === 0 ? null : (
            <ul className="flex flex-col">
              {dayRows.map((appointment: AppointmentRecord) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 items-baseline gap-4">
                    <span className="tabular w-28 shrink-0 text-[0.9375rem] font-medium">
                      {sedeTimeRange(appointment.startsAt, appointment.durationMin, sedeTimezone)}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[0.8125rem]">
                        {patientNames.get(appointment.patientId) ?? 'Paciente sin nombre en el alcance'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {userNames.get(appointment.professionalId) ?? 'Profesional sin nombre en el alcance'}
                      </span>
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {appointmentStatusLabel(appointment.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <EnabledScreens links={links} />
    </div>
  );
}

/** One day count: label, big number and a one-line hint. */
function DayCount({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint: string }) {
  return (
    <Card>
      <CardHeader>
        <CardEyebrow>{label}</CardEyebrow>
        <CardTitle as="h3" className="tabular text-2xl">
          {value}
        </CardTitle>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
    </Card>
  );
}

/**
 * Link list to the enabled screens of the role. Local copy of the shell list
 * so this cover stays self-contained inside its own file.
 */
function EnabledScreens({ links }: { readonly links: readonly HomeLink[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Pantallas habilitadas para su rol</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {links.length === 0 ? (
          <p className="text-muted-foreground">
            Su rol no habilita ninguna pantalla del alcance actual. Si necesita acceso, avise a
            jefatura o a soporte.
          </p>
        ) : (
          links.map((link) => (
            <Link
              key={link.path}
              href={link.path}
              className="group flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3 transition-colors hover:bg-secondary"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-accent-tint text-accent"
                >
                  <RouteIcon path={link.path} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.description}</span>
                </span>
              </span>
              <IconArrowRight className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
