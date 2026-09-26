'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AppointmentRecord, EpisodeRecord, PatientRecord } from '@rizoma/contracts';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton';
import { ConsentsPanel } from '@/components/salud/consents-panel';
import { EpisodesPanel } from '@/components/salud/episodes-panel';
import { PrescriptionsPanel } from '@/components/salud/prescriptions-panel';
import { TriagesPanel } from '@/components/salud/triages-panel';
import { EmptyState, FailurePanel } from '@/components/salud/states';
import { IconAlertTriangle, IconArrowRight } from '@/components/ui/icons';
import { documentTypeLabel, appointmentStatusLabel, appointmentStatusVariant, roleLabel } from '@/lib/labels';
import { type ApiFailure } from '@/lib/salud-errors';
import { getPatient, listAppointments, listEpisodes } from '@/lib/salud-api';
import { appointmentsOfPatient } from '@/lib/salud-select';
import { formatUtcDate, utcDateOf, utcTimeRange } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * `/salud/pacientes/[id]` — the ficha 360.
 *
 * The screen is the composition of the six things a patient file is made of,
 * plus one deliberate omission:
 *   - the header, where allergies and alerts are rendered *above* every clinical
 *     action (a file that hides an allergy behind a tab is a safety defect);
 *   - the episodes, triage, prescription and consent panels, each owning its own
 *     request and its own writes;
 *   - the appointments of the patient, filtered **in the browser** because
 *     `GET /v1/salud/appointments` lists the agenda of the sede and takes no
 *     `?patient=` parameter;
 *   - the account block, which is a *link* to `/salud/caja` and never an amount.
 *     The clinical/billing separation is a hard rule of the MVP: a physician
 *     never sees a total on this screen, and the link is only offered to a role
 *     that could actually open caja (`invoice.issue`), so the UI never invites a
 *     request the API would answer with 403.
 *
 * Reception reaches this route only through a denial: opening a ficha requires
 * `patient.read`, which reception does not hold. The route rule (`patient.read`,
 * mode `all`) mirrors the endpoint, so the refusal happens in the guard with the
 * same `reason` the API would return.
 */
export interface PatientFileProps {
  readonly patientId: string;
  readonly role: string | null;
  /** `patient.write` — consents: create, sign, revoke. */
  readonly canWrite: boolean;
  /** `episode.write` — episodes: open, close. */
  readonly canEpisodeWrite: boolean;
  /** `invoice.issue` — the only role that reaches `/salud/caja`. */
  readonly canInvoice: boolean;
}

export function PatientFile({
  patientId,
  role,
  canWrite,
  canEpisodeWrite,
  canInvoice,
}: PatientFileProps) {
  const patient = useResource<PatientRecord>(`patient:${patientId}`, (signal) =>
    getPatient(patientId, signal),
  );
  const episodes = useResource<EpisodeRecord[]>('episodes', (signal) => listEpisodes(signal));
  const appointments = useResource<AppointmentRecord[]>('appointments', (signal) =>
    listAppointments(signal),
  );

  if (patient.loading) {
    return (
      <div className="flex flex-col gap-6">
        <Card tone="accent">
          <CardHeader>
            <CardEyebrow>Ficha 360 · paciente</CardEyebrow>
            <Skeleton className="h-5 w-56" delay={0} />
            <Skeleton className="h-3 w-72" delay={60} />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-5 w-24 rounded-full" delay={120} />
              <Skeleton className="h-5 w-40 rounded-full" delay={180} />
              <Skeleton className="h-5 w-52 rounded-full" delay={240} />
            </div>
            <Skeleton className="h-16 w-full" delay={300} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Skeleton className="h-3 w-32" delay={0} />
            <Skeleton className="h-4 w-48" delay={60} />
          </CardHeader>
          <CardContent>
            <SkeletonRows rows={2} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (patient.failure !== null || patient.data === null) {
    return (
      <FailurePanel
        title="No se pudo abrir la ficha del paciente"
        failure={
          patient.failure ?? {
            kind: 'unexpected',
            status: null,
            code: 'client.error',
            reason: null,
            traceId: null,
            message: 'La ficha no devolvió datos.',
            hint: 'Reintente desde la lista de pacientes.',
          }
        }
        onRetry={patient.reload}
      />
    );
  }

  const record = patient.data;

  return (
    <div className="flex flex-col gap-6">
      <Card tone="accent">
        <CardHeader>
          <CardEyebrow>Ficha 360 · paciente</CardEyebrow>
          <CardTitle as="h2" className="text-lg">
            {record.personName}
          </CardTitle>
          <CardDescription>
            <span className="tabular font-mono text-xs">
              {documentTypeLabel(record.documentType)} {record.documentNumber}
            </span>{' '}
            ·{' '}
            {record.birthdate === null
              ? 'sin fecha de nacimiento'
              : `nacimiento ${formatUtcDate(record.birthdate)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={record.active ? 'tinted' : 'danger'}>
              {record.active ? 'Ficha activa' : 'Ficha inactiva'}
            </Badge>
            <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
              id {record.id}
            </span>
            <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
              sede {record.orgNodeId}
            </span>
            <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
              creada {formatUtcDate(utcDateOf(record.createdAt) ?? '')}
            </span>
          </div>

          {record.allergies.length === 0 && record.alerts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Sin alergias ni alertas registradas en la ficha. El campo está presente y vacío: la
              ausencia de dato es un dato.
            </p>
          ) : (
            <Alert
              variant="denied"
              icon={<IconAlertTriangle className="mt-0.5 h-4 w-4 text-danger" />}
              title="Alergias y alertas antes de cualquier acción clínica"
            >
              <div className="flex flex-wrap gap-2">
                {record.allergies.map((allergy) => (
                  <Badge key={`allergy-${allergy}`} variant="danger">
                    Alergia: {allergy}
                  </Badge>
                ))}
                {record.alerts.map((alert) => (
                  <Badge key={`alert-${alert}`} variant="outline">
                    Alerta: {alert}
                  </Badge>
                ))}
              </div>
            </Alert>
          )}

          {Object.keys(record.contacts).length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <span className="text-[0.8125rem] font-medium">Contactos</span>
              <span className="tabular font-mono text-xs text-muted-foreground">
                {JSON.stringify(record.contacts)}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <EpisodesPanel patientId={record.id} canWrite={canEpisodeWrite} resource={episodes} />

      <TriagesPanel patientId={record.id} episodes={episodes.data ?? []} canWrite={canWrite} />

      <PrescriptionsPanel
        patientId={record.id}
        episodes={episodes.data ?? []}
        canWrite={canEpisodeWrite}
      />

      <ConsentsPanel
        patientId={record.id}
        patient={record}
        episodes={episodes.data ?? []}
        canWrite={canWrite}
      />

      <PatientAppointments
        patientId={record.id}
        appointments={appointments.data}
        loading={appointments.loading}
        failure={appointments.failure}
        onRetry={appointments.reload}
      />

      <Card>
        <CardHeader>
          <CardEyebrow>Cuenta del paciente</CardEyebrow>
          <CardTitle as="h2">Cobros y comprobantes</CardTitle>
          <CardDescription>
            La ficha clínica no muestra importes: la separación clínica/facturación es una regla del
            MVP, y el contrato de caja del API no transporta datos clínicos en la dirección
            contraria.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {canInvoice ? (
            <>
              <Link href="/salud/caja" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                Ir a caja
                <IconArrowRight />
              </Link>
              <span className="text-xs text-muted-foreground">
                Turno de caja, cotizaciones, emisión y cobro llegan en W3. La cuenta se abre allí y
                nunca aquí.
              </span>
            </>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">
                El rol {roleLabel(role)} no puede abrir la caja desde aquí: la opción no se ofrece
                y ningún importe se muestra en esta pantalla. Si necesita este acceso, avise a
                jefatura o a soporte.
              </span>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                  Copiar detalle
                </summary>
                <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                  {`code: access.denied\nreason: role.denied\nstatus: 403\naction: invoice.issue`}
                </pre>
              </details>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface PatientAppointmentsProps {
  readonly patientId: string;
  readonly appointments: AppointmentRecord[] | null;
  readonly loading: boolean;
  readonly failure: ApiFailure | null;
  readonly onRetry: () => void;
}

/**
 * Appointments of one patient, filtered in the browser.
 *
 * The endpoint returns the agenda of the sede (up to 200 rows) and has no
 * `?patient=` filter, so this section says so: it shows the appointments it could
 * match in the loaded rows and counts them, instead of implying a server-side
 * query.
 */
function PatientAppointments({
  patientId,
  appointments,
  loading,
  failure,
  onRetry,
}: PatientAppointmentsProps) {
  const [showAll, setShowAll] = useState(false);
  const mine = appointmentsOfPatient(appointments ?? [], patientId);
  const rows = showAll ? (appointments ?? []) : mine;

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Citas del paciente</CardEyebrow>
        <CardTitle as="h2">Citas registradas</CardTitle>
        <CardDescription>
          Filtro local sobre la agenda de la sede: <code className="font-mono text-xs">GET
          /v1/salud/appointments</code> no acepta <code className="font-mono text-xs">?patient=</code>,
          así que la pantalla indica cuántas citas del alcance pertenecen a esta ficha.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            {loading
              ? 'leyendo…'
              : `${mine.length} cita${mine.length === 1 ? '' : 's'} de este paciente de ${appointments?.length ?? 0} en el alcance`}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Ver solo las de esta ficha' : 'Ver toda la agenda del alcance'}
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onRetry} disabled={loading}>
            Actualizar
          </Button>
        </div>

        {loading ? <SkeletonRows rows={2} /> : null}

        {!loading && failure !== null ? (
          <FailurePanel title="No se pudieron leer las citas" failure={failure} onRetry={onRetry} />
        ) : null}

        {!loading && failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin citas"
            title={showAll ? 'La agenda del alcance está vacía' : 'Esta ficha no tiene citas'}
            description="El API respondió con una lista válida. La agenda se programa en /salud/agenda; aquí solo se lee, para no duplicar el formulario de creación."
          />
        ) : null}

        {rows.length === 0 ? null : (
          <ul className="flex flex-col">
            {rows.map((appointment) => (
              <li
                key={appointment.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="tabular text-[0.8125rem]">
                    {formatUtcDate(utcDateOf(appointment.startsAt) ?? '')} ·{' '}
                    {utcTimeRange(appointment.startsAt, appointment.durationMin)} UTC
                  </span>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    profesional {appointment.professionalId.slice(0, 8)}… · paciente{' '}
                    {appointment.patientId.slice(0, 8)}…
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
  );
}
