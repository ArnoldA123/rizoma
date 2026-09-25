'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  APPOINTMENT_DURATION_DEFAULT_MIN,
  APPOINTMENT_DURATION_MAX_MIN,
  checkDateTimeField,
  checkDurationField,
  checkUuidField,
  firstIssue,
  type AppointmentRecord,
  type FieldCheck,
} from '@rizoma/contracts';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, SavedPulse, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { MagneticCta } from '@/components/ui/magnetic';
import { FailurePanel } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createAppointment } from '@/lib/salud-api';
import { dateTimeLocalToUtcIso } from '@/lib/salud-time';
import { cn } from '@/lib/utils';

/**
 * Appointment scheduling form (`appointment.write`, i.e. reception).
 *
 * Three decisions worth naming:
 *   - **UTC end to end.** The control is a `datetime-local`, because a person
 *     schedules a wall-clock time; the value is converted once, here, into the
 *     offset-aware instant the API stores. Everything the screen *shows* is UTC,
 *     so the day filter and the agenda agree with `?date=` on the dashboards.
 *   - **Identifiers are explicit.** MVP1 has no patient search endpoint, and
 *     reception cannot read patient files at all (`patient.read` is not granted),
 *     so the form takes the patient, the professional and the sede as UUIDs. That
 *     is a real limitation of the API surface, and the field hints say so instead
 *     of pretending a picker exists.
 *   - **Live validation** with the contract rules, a verdict per field, and a
 *     magnetic primary CTA — the one premium motion of this screen.
 */
export interface AppointmentFormProps {
  /** UTC day the agenda is showing; seeds the date part of the control. */
  readonly day: string;
  /** Sede prefill; the agenda passes the last one it read from a real row. */
  readonly defaultOrgNodeId: string;
  /** Called once per created appointment, with the API row. */
  readonly onCreated: (appointment: AppointmentRecord) => void;
  readonly className?: string;
}

interface Draft {
  orgNodeId: string;
  patientId: string;
  professionalId: string;
  startsAt: string;
  durationMin: string;
}

function initialDraft(day: string, orgNodeId: string): Draft {
  return {
    orgNodeId,
    patientId: '',
    professionalId: '',
    // 09:00 of the selected UTC day, a plausible demo slot.
    startsAt: `${day}T09:00`,
    durationMin: String(APPOINTMENT_DURATION_DEFAULT_MIN),
  };
}

export function AppointmentForm({
  day,
  defaultOrgNodeId,
  onCreated,
  className,
}: AppointmentFormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(day, defaultOrgNodeId));
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [created, setCreated] = useState<AppointmentRecord | null>(null);

  const checks: Readonly<Record<string, FieldCheck>> = {
    orgNodeId: checkUuidField('orgNodeId', draft.orgNodeId),
    patientId: checkUuidField('patientId', draft.patientId),
    professionalId: checkUuidField('professionalId', draft.professionalId),
    startsAt: checkDateTimeField('startsAt', draft.startsAt),
    durationMin: checkDurationField('durationMin', draft.durationMin),
  };

  const show = (field: string): boolean => touched[field] === true || submitted;

  function set<K extends keyof Draft>(field: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    const startsAt = dateTimeLocalToUtcIso(draft.startsAt);
    if (startsAt === null) {
      // Unreachable while `checkDateTimeField` passed, but the conversion is the
      // one step that could still fail, so it is handled instead of asserted.
      setFailure({
        kind: 'client',
        status: null,
        code: 'client.invalid_datetime',
        reason: null,
        traceId: null,
        message: 'La fecha y hora no se pudieron convertir a UTC.',
        hint: 'Corrija el campo de fecha y hora.',
      });
      return;
    }

    setSaving(true);
    try {
      const appointment = await createAppointment({
        orgNodeId: draft.orgNodeId.trim(),
        patientId: draft.patientId.trim(),
        professionalId: draft.professionalId.trim(),
        startsAt,
        durationMin: Number(draft.durationMin),
      });
      setCreated(appointment);
      onCreated(appointment);
      setDraft({ ...initialDraft(day, appointment.orgNodeId), patientId: '', professionalId: '' });
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} tone="accent">
      <CardHeader>
        <CardEyebrow>Programar cita</CardEyebrow>
        <CardTitle as="h2">Nueva cita</CardTitle>
        <CardDescription>
          La hora se escribe en hora local y se envía como instante con offset; la agenda agrupa por
          día UTC. Paciente, profesional y sede viajan como UUID porque MVP1 no expone búsqueda de
          pacientes ni listado de nodos.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
          <div className="grid gap-5 sm:grid-cols-2">
            <LiveInput
              id="appointment-starts-at"
              label="Fecha y hora (hora local)"
              hint="Se convierte a instante UTC con offset."
              issue={checks.startsAt ?? null}
              touched={show('startsAt')}
            >
              <Input
                id="appointment-starts-at"
                type="datetime-local"
                value={draft.startsAt}
                onChange={(event) => set('startsAt', event.target.value)}
                onBlur={() => touch('startsAt')}
                {...fieldStateProps(checks.startsAt ?? null, show('startsAt'))}
              />
            </LiveInput>

            <LiveInput
              id="appointment-duration"
              label="Duración (minutos)"
              hint={`Entre 1 y ${APPOINTMENT_DURATION_MAX_MIN}.`}
              issue={checks.durationMin ?? null}
              touched={show('durationMin')}
            >
              <Input
                id="appointment-duration"
                inputMode="numeric"
                value={draft.durationMin}
                onChange={(event) => set('durationMin', event.target.value)}
                onBlur={() => touch('durationMin')}
                {...fieldStateProps(checks.durationMin ?? null, show('durationMin'))}
              />
            </LiveInput>

            <LiveInput
              id="appointment-patient"
              label="Paciente (UUID)"
              hint="Recepción no lee fichas: el identificador se recibe del mostrador."
              issue={checks.patientId ?? null}
              touched={show('patientId')}
            >
              <Input
                id="appointment-patient"
                className="font-mono text-xs"
                spellCheck={false}
                value={draft.patientId}
                onChange={(event) => set('patientId', event.target.value)}
                onBlur={() => touch('patientId')}
                {...fieldStateProps(checks.patientId ?? null, show('patientId'))}
              />
            </LiveInput>

            <LiveInput
              id="appointment-professional"
              label="Profesional (UUID)"
              issue={checks.professionalId ?? null}
              touched={show('professionalId')}
            >
              <Input
                id="appointment-professional"
                className="font-mono text-xs"
                spellCheck={false}
                value={draft.professionalId}
                onChange={(event) => set('professionalId', event.target.value)}
                onBlur={() => touch('professionalId')}
                {...fieldStateProps(checks.professionalId ?? null, show('professionalId'))}
              />
            </LiveInput>

            <LiveInput
              id="appointment-org-node"
              label="Sede (UUID)"
              className="sm:col-span-2"
              issue={checks.orgNodeId ?? null}
              touched={show('orgNodeId')}
            >
              <Input
                id="appointment-org-node"
                className="font-mono text-xs"
                spellCheck={false}
                value={draft.orgNodeId}
                onChange={(event) => set('orgNodeId', event.target.value)}
                onBlur={() => touch('orgNodeId')}
                {...fieldStateProps(checks.orgNodeId ?? null, show('orgNodeId'))}
              />
            </LiveInput>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <MagneticCta type="submit" disabled={saving}>
              {saving ? 'Programando…' : 'Programar cita'}
            </MagneticCta>
            {created === null ? null : (
              <SavedPulse label="Cita programada" resetKey={created.id} />
            )}
          </div>
        </form>

        {failure === null ? null : (
          <FailurePanel className="mt-4" title="La cita no se programó" failure={failure} />
        )}
      </CardContent>
    </Card>
  );
}

interface LiveInputProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly issue: FieldCheck;
  readonly touched: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

function LiveInput({ id, label, hint, issue, touched, className, children }: LiveInputProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldMessage issue={issue} touched={touched} validLabel="Dato aceptado." />
    </div>
  );
}
