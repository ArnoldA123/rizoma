'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EpisodeRecord, FieldCheck, TriageRecord } from '@rizoma/contracts';
import { checkNumberField, checkOptionalText, checkOptionalUuidField, firstIssue } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createTriage, listTriages } from '@/lib/salud-api';
import { formatUtcDate, utcDateOf, utcTimeOf } from '@/lib/salud-time';

/**
 * Triage panel of the ficha 360 — insert-only vital signs (§2.3).
 *
 * The panel owns the history read and the record write. There is deliberately
 * no edit or delete affordance: a correction is a new row, so the API exposes
 * only `GET` and `POST`, and this panel renders exactly those two. The form
 * collects the vital signs as individual numeric fields and ships them as the
 * `values` bag the API stores; the recorder and the timestamp come from the
 * session and the server clock, never from the form.
 */
export interface TriagesPanelProps {
  readonly patientId: string;
  /** Episodes of this patient, for the optional episode link. */
  readonly episodes: readonly EpisodeRecord[];
  /** `patient.write` — recording a triage requires it. */
  readonly canWrite: boolean;
  readonly className?: string;
}

/** Vital-sign fields the form renders, in display order. */
const VITAL_FIELDS = [
  { key: 'systolic', label: 'Sistólica (mmHg)' },
  { key: 'diastolic', label: 'Diastólica (mmHg)' },
  { key: 'heartRate', label: 'Frecuencia cardíaca (lpm)' },
  { key: 'temperatureC', label: 'Temperatura (°C)' },
  { key: 'spo2', label: 'SpO2 (%)' },
  { key: 'weightKg', label: 'Peso (kg)' },
] as const;

export function TriagesPanel({ patientId, episodes, canWrite, className }: TriagesPanelProps) {
  const [triages, setTriages] = useState<TriageRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailure, setReadFailure] = useState<ApiFailure | null>(null);
  const [writeFailure, setWriteFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    listTriages(patientId, controller.signal)
      .then((rows) => {
        if (!active) return;
        setTriages(rows);
        setReadFailure(null);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setReadFailure(classifyApiError(error));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [patientId, reloadKey]);

  const rows = triages ?? [];

  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Triaje</CardEyebrow>
        <CardTitle as="h2">Signos vitales</CardTitle>
        <CardDescription>
          Historial de tomas de la ficha, el más reciente primero. El triaje es de solo
          inserción: una corrección es una fila nueva, nunca una edición.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            {loading ? 'leyendo…' : `${rows.length} toma${rows.length === 1 ? '' : 's'}`}
          </span>
          <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
            Actualizar
          </Button>
          {canWrite ? (
            <Button
              variant={formOpen ? 'ghost' : 'outline'}
              size="sm"
              className="ml-auto"
              onClick={() => setFormOpen((open) => !open)}
            >
              {formOpen ? 'Cerrar formulario' : 'Registrar toma'}
            </Button>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground">
              Sin <code className="font-mono">patient.write</code>: lectura solamente.
            </span>
          )}
        </div>

        {formOpen && canWrite ? (
          <TriageForm
            patientId={patientId}
            episodes={episodes}
            onCreated={(created) => {
              setTriages((current) => [created, ...(current ?? [])]);
              setWriteFailure(null);
              setSuccess('Toma registrada con la hora del servidor.');
              setFormOpen(false);
            }}
          />
        ) : null}

        {triages === null ? null : <WriteResult failure={writeFailure} success={success} />}

        {loading ? <SkeletonRows rows={2} /> : null}

        {!loading && readFailure !== null ? (
          <FailurePanel title="No se pudo leer el triaje" failure={readFailure} onRetry={reload} />
        ) : null}

        {!loading && readFailure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin tomas"
            title="Esta ficha no tiene signos vitales registrados"
            description="El API respondió con una lista válida y vacía. La primera toma se registra desde aquí cuando el rol tiene patient.write."
          />
        ) : null}

        {rows.length === 0 ? null : (
          <ul className="flex flex-col">
            {rows.map((triage) => (
              <li
                key={triage.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="tabular text-[0.8125rem]">
                    {triage.at === null
                      ? 'sin hora registrada'
                      : `${formatUtcDate(utcDateOf(triage.at) ?? '')} · ${utcTimeOf(triage.at)} UTC`}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(triage.values).map(([key, value]) => (
                      <Badge key={`${triage.id}-${key}`} variant="outline">
                        {key}: {String(value)}
                      </Badge>
                    ))}
                  </div>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    {triage.episodeId === null
                      ? 'sin episodio'
                      : `episodio ${triage.episodeId.slice(0, 8)}…`}
                    {' · registró '}
                    {triage.recordedBy.slice(0, 8)}…
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface TriageFormProps {
  readonly patientId: string;
  readonly episodes: readonly EpisodeRecord[];
  readonly onCreated: (triage: TriageRecord) => void;
}

/** Record form: at least one vital sign, optional episode link, server timestamp. */
function TriageForm({ patientId, episodes, onCreated }: TriageFormProps) {
  const [episodeId, setEpisodeId] = useState('');
  const [vitals, setVitals] = useState<Readonly<Record<string, string>>>({});
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const checks: Readonly<Record<string, FieldCheck>> = {
    episodeId: checkOptionalUuidField('episodeId', episodeId),
    ...Object.fromEntries(
      VITAL_FIELDS.map(({ key }) => [
        key,
        (vitals[key] ?? '').trim() === '' ? null : checkNumberField(key, vitals[key] ?? ''),
      ]),
    ),
    note: checkOptionalText('note', note, 280),
  };
  const hasVital = VITAL_FIELDS.some((field) => (vitals[field.key] ?? '').trim() !== '');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null || !hasVital) return;

    const values: Record<string, number | string> = {};
    for (const { key } of VITAL_FIELDS) {
      const raw = (vitals[key] ?? '').trim();
      if (raw !== '') values[key] = Number(raw);
    }
    if (note.trim() !== '') values.note = note.trim();

    setSaving(true);
    try {
      const created = await createTriage({
        patientId,
        ...(episodeId.trim() === '' ? {} : { episodeId: episodeId.trim() }),
        values,
      });
      setEpisodeId('');
      setVitals({});
      setNote('');
      setTouched(false);
      onCreated(created);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="sd-rise flex flex-col gap-4 rounded-md border border-border bg-secondary p-4"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="triage-episode" className="text-[0.8125rem] font-medium">
            Episodio (opcional)
          </label>
          {episodes.length === 0 ? (
            <Input
              id="triage-episode"
              className="font-mono text-xs"
              spellCheck={false}
              placeholder="UUID del episodio o vacío"
              value={episodeId}
              onChange={(event) => setEpisodeId(event.target.value)}
              onBlur={() => setTouched(true)}
              {...fieldStateProps(checks.episodeId ?? null, touched)}
            />
          ) : (
            <Select
              id="triage-episode"
              value={episodeId}
              onChange={(event) => setEpisodeId(event.target.value)}
              onBlur={() => setTouched(true)}
            >
              <option value="">Sin episodio</option>
              {episodes.map((episode) => (
                <option key={episode.id} value={episode.id}>
                  {episode.specialty} · {episode.id.slice(0, 8)}… ·{' '}
                  {episode.status === 'open' ? 'abierto' : 'cerrado'}
                </option>
              ))}
            </Select>
          )}
          <FieldMessage issue={checks.episodeId ?? null} touched={touched} validLabel="Dato aceptado." />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="triage-note" className="text-[0.8125rem] font-medium">
            Nota (opcional)
          </label>
          <Input
            id="triage-note"
            value={note}
            maxLength={280}
            placeholder="Observación de la toma"
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.note ?? null, touched)}
          />
          <FieldMessage issue={checks.note ?? null} touched={touched} validLabel="Dato aceptado." />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {VITAL_FIELDS.map(({ key, label }) => (
          <div key={key} className="flex flex-col gap-1.5">
            <label htmlFor={`triage-${key}`} className="text-[0.8125rem] font-medium">
              {label}
            </label>
            <Input
              id={`triage-${key}`}
              inputMode="decimal"
              value={vitals[key] ?? ''}
              onChange={(event) => setVitals((current) => ({ ...current, [key]: event.target.value }))}
              onBlur={() => setTouched(true)}
              {...fieldStateProps(checks[key] ?? null, touched)}
            />
            <FieldMessage issue={checks[key] ?? null} touched={touched} validLabel="Dato aceptado." />
          </div>
        ))}
      </div>

      {touched && !hasVital ? (
        <p className="text-xs text-danger">Registre al menos un signo vital.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          La hora la estampa el servidor al registrar; quien registra es el usuario de la sesión.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" type="submit" size="sm" disabled={saving}>
          {saving ? 'Registrando…' : 'Registrar toma'}
        </Button>
      </div>

      {failure === null ? null : <FailurePanel title="La toma no se registró" failure={failure} />}
    </form>
  );
}
