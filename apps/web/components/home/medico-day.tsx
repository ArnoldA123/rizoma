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
import { appointmentsOfProfessional, appointmentsOnUtcDate } from '@/lib/salud-select';
import { currentUtcDate, formatUtcDateLong, utcTimeRange } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import type { HomeLink } from './role-home';

export interface MedicoDayProps {
  /** User id of the session, used to focus the physician's own appointments. */
  readonly viewerId: string | null;
  readonly links: readonly HomeLink[];
}

/**
 * Day cover of the médico role (P3-1a).
 *
 * Counts come from the médico board (`myAppointments`, `openEpisodes`,
 * `pendingConsents`); the rows below are the physician's own appointments of
 * today in UTC, with patient names resolved against the scope lists. No
 * identifier is rendered — names own the rows.
 */
export function MedicoDay({ viewerId, links }: MedicoDayProps) {
  const today = currentUtcDate();
  const board = useResource('home-board:medico', (signal) => getSaludBoard('medico', {}, signal));
  const agenda = useResource('home-agenda:medico', (signal) => listAppointments(signal));
  const [patientNames, setPatientNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [userNames, setUserNames] = useState<ReadonlyMap<string, string>>(new Map());

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

  const medicoBoard = board.data !== null && board.data.role === 'medico' ? board.data : null;
  const ownRows = appointmentsOfProfessional(
    appointmentsOnUtcDate(agenda.data ?? [], today),
    viewerId,
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Médico · hoy (UTC)"
        title="Sus citas de hoy"
        description={`${formatUtcDateLong(today)}: sus citas con nombre y hora, más sus episodios abiertos y consentimientos por firmar.`}
        action={
          <Link href="/salud/tableros/medico" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Abrir mi tablero
          </Link>
        }
      />

      {board.failure !== null ? (
        <FailurePanel title="No se pudo leer su día" failure={board.failure} onRetry={board.reload} />
      ) : null}

      {board.loading && medicoBoard === null ? (
        <SkeletonRows rows={3} />
      ) : medicoBoard === null ? null : (
        <div className="grid gap-4 sm:grid-cols-3">
          <DayCount label="Mis citas de hoy" value={String(medicoBoard.myAppointments)} hint="Solo las propias" />
          <DayCount label="Episodios abiertos" value={String(medicoBoard.openEpisodes)} hint="A mi nombre" />
          <DayCount label="Consentimientos pendientes" value={String(medicoBoard.pendingConsents)} hint="Por firmar" />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardEyebrow>Citas de hoy</CardEyebrow>
          <CardTitle as="h2">Su agenda del día</CardTitle>
          <CardDescription>
            Solo sus citas, ordenadas por hora de inicio. La agenda completa de la sede vive en la
            pantalla de agenda.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {agenda.loading && ownRows.length === 0 ? <SkeletonRows rows={3} /> : null}
          {!agenda.loading && agenda.failure !== null ? (
            <FailurePanel
              title="No se pudieron leer sus citas"
              failure={agenda.failure}
              onRetry={agenda.reload}
            />
          ) : null}
          {!agenda.loading && agenda.failure === null && ownRows.length === 0 ? (
            <EmptyState
              eyebrow="Sin citas"
              title="Sin citas propias hoy"
              description="El API respondió con una lista válida: hoy no tiene citas a su nombre en el alcance actual."
            />
          ) : null}
          {ownRows.length === 0 ? null : (
            <ul className="flex flex-col">
              {ownRows.map((appointment: AppointmentRecord) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 items-baseline gap-4">
                    <span className="tabular w-28 shrink-0 text-[0.9375rem] font-medium">
                      {utcTimeRange(appointment.startsAt, appointment.durationMin)}
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
