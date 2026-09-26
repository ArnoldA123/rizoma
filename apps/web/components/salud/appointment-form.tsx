'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Input } from '@/components/ui/input';
import { MagneticCta } from '@/components/ui/magnetic';
import { FailurePanel } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createAppointment, listPatients } from '@/lib/salud-api';
import { listOrgNodes } from '@/lib/org-api';
import { listUsers } from '@/lib/users-api';
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
 *   - **Identifiers are picked, not typed.** Patient, professional and sede
 *     come from the scope lists with a browser-side search; the id travels as
 *     the option value and only names are visible.
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
  const [patientItems, setPatientItems] = useState<readonly EntityItem[]>([]);
  const [professionalItems, setProfessionalItems] = useState<readonly EntityItem[]>([]);
  const [sedeItems, setSedeItems] = useState<readonly EntityItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listPatients(controller.signal)
      .then((rows) => {
        if (!active) return;
        setPatientItems(
          rows.map((row) => ({
            id: row.id,
            label: row.personName,
            sub: `${row.documentType} ${row.documentNumber}`,
          })),
        );
      })
      .catch(() => {
        if (active) setPatientItems([]);
      });
    listUsers({ role: 'medico' }, controller.signal)
      .then((rows) => {
        if (!active) return;
        setProfessionalItems(
          rows.map((row) => ({ id: row.id, label: row.name, sub: row.email })),
        );
      })
      .catch(() => {
        if (active) setProfessionalItems([]);
      });
    listOrgNodes({ kind: 'sede' }, controller.signal)
      .then((rows) => {
        if (!active) return;
        setSedeItems(rows.map((row) => ({ id: row.id, label: row.name })));
      })
      .catch(() => {
        if (active) setSedeItems([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

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
          día UTC. Paciente, profesional y sede se eligen de la lista del alcance con buscador.
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

            <div className="flex flex-col gap-1.5">
              <EntitySelector
                label="Paciente"
                items={patientItems}
                value={draft.patientId === '' ? null : draft.patientId}
                onChange={(id) => {
                  set('patientId', id ?? '');
                  touch('patientId');
                }}
                placeholder="Seleccionar paciente…"
                searchPlaceholder="Buscar por nombre…"
              />
              <FieldMessage issue={checks.patientId ?? null} touched={show('patientId')} validLabel="Dato aceptado." />
            </div>

            <div className="flex flex-col gap-1.5">
              <EntitySelector
                label="Profesional"
                items={professionalItems}
                value={draft.professionalId === '' ? null : draft.professionalId}
                onChange={(id) => {
                  set('professionalId', id ?? '');
                  touch('professionalId');
                }}
                placeholder="Seleccionar profesional…"
                searchPlaceholder="Buscar por nombre…"
              />
              <FieldMessage issue={checks.professionalId ?? null} touched={show('professionalId')} validLabel="Dato aceptado." />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <EntitySelector
                label="Sede"
                items={sedeItems}
                value={draft.orgNodeId === '' ? null : draft.orgNodeId}
                onChange={(id) => {
                  set('orgNodeId', id ?? '');
                  touch('orgNodeId');
                }}
                placeholder="Seleccionar sede…"
                searchPlaceholder="Buscar por nombre…"
              />
              <FieldMessage issue={checks.orgNodeId ?? null} touched={show('orgNodeId')} validLabel="Dato aceptado." />
            </div>
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
