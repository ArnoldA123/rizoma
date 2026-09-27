'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { EpisodeRecord, FieldCheck, TriageRecord } from '@rizoma/contracts';
import { checkDateField, checkNumberField, checkOptionalText, checkOptionalUuidField, checkRequiredText, firstIssue } from '@rizoma/contracts';
import { requestJson } from '@/lib/api-client';
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
import { listUsers } from '@/lib/users-api';
import { formatSedeStamp } from '@/lib/salud-time';
import { useSedeTimezone } from '@/lib/use-sede-timezone';

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
  /**
   * Sede of the ficha (P4-1c): triages carry no sede of their own, so the
   * caller lends it. Absent, the rows read in the Lima fallback.
   */
  readonly orgNodeId?: string | null;
  readonly className?: string;
}

/**
 * Typed custom key of `triages.values` (B2). Local schema until
 * `packages/contracts/src/index.ts` re-exports `./custom-fields.ts` — it
 * mirrors `customFieldDefSchema` field by field, so the form below renders
 * exactly the `active` definitions the API would enforce on arrival.
 */
const customFieldDefSchema = z.object({
  id: z.string(),
  module: z.string(),
  entity: z.string(),
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  type: z.enum(['text', 'number', 'date', 'boolean']),
  required: z.boolean(),
  status: z.string(),
});
type CustomFieldDef = z.infer<typeof customFieldDefSchema>;

/** Free-text custom value cap; the API stores the bag as JSONB, not a column. */
const CUSTOM_TEXT_MAX = 500;

/** Live check of one custom value, mirroring `validateCustomValues` server-side. */
function checkCustomField(def: CustomFieldDef, raw: string): FieldCheck {
  const field = `custom.${def.code}`;
  const value = (raw ?? '').trim();
  if (value === '') return def.required ? { field, code: 'required' } : null;
  switch (def.type) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : { field, code: 'invalid_number' };
    case 'date':
      return checkDateField(field, value);
    case 'boolean':
      return null;
    case 'text':
      return def.required
        ? checkRequiredText(field, value, CUSTOM_TEXT_MAX)
        : checkOptionalText(field, value, CUSTOM_TEXT_MAX);
  }
}

/** Parses the string-held custom values into the JSONB bag the API types. */
function parseCustomValues(
  defs: readonly CustomFieldDef[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = (values[def.code] ?? '').trim();
    if (raw === '') continue;
    if (def.type === 'number') bag[def.code] = Number(raw);
    else if (def.type === 'boolean') bag[def.code] = raw === 'true';
    else bag[def.code] = raw;
  }
  return bag;
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

/** Spanish label of one `values` key: vitals from `VITAL_FIELDS`, `note` as
 * Nota, and any tenant custom code as neutral text (the code is the label
 * the tenant defined). Raw storage keys never reach the screen. */
const VITAL_LABEL_BY_KEY: Readonly<Record<string, string>> = Object.fromEntries([
  ...VITAL_FIELDS.map(({ key, label }) => [key, label] as const),
  ['note', 'Nota'] as const,
]);

function vitalValueLabel(key: string): string {
  return VITAL_LABEL_BY_KEY[key] ?? key;
}

export function TriagesPanel({ patientId, episodes, canWrite, orgNodeId, className }: TriagesPanelProps) {
  // Triages carry no sede of their own: the zone is the ficha's, Lima
  // fallback when the panel is used without one.
  const sede = useSedeTimezone(orgNodeId ?? null);
  const [triages, setTriages] = useState<TriageRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailure, setReadFailure] = useState<ApiFailure | null>(null);
  const [writeFailure, setWriteFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Recorder names: the triage endpoint carries only the id, so it resolves
  // in the browser against the personnel list. A failed read leaves the map
  // empty and the row falls back to the short id (P2-2a convention).
  const [userNames, setUserNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listUsers({}, controller.signal)
      .then((rows) => {
        if (!active) return;
        setUserNames(new Map(rows.map((row) => [row.id, row.name])));
      })
      .catch(() => {
        if (active) setUserNames(new Map());
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  // Episodes of this patient by id: the history links each row to its episode
  // by name (specialty + date) instead of the raw id.
  const episodeById = useMemo(
    () => new Map(episodes.map((episode) => [episode.id, episode] as const)),
    [episodes],
  );

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
            {rows.map((triage) => {
              const episode =
                triage.episodeId === null ? undefined : episodeById.get(triage.episodeId);
              const episodeName =
                triage.episodeId === null
                  ? 'sin episodio'
                  : (episode === undefined
                      ? `episodio ${triage.episodeId.slice(0, 8)}…`
                      : `${episode.specialty}${(episode.openedAt ?? '').slice(0, 10) === '' ? '' : ` · ${(episode.openedAt ?? '').slice(0, 10)}`}`);
              const recorderName =
                userNames.get(triage.recordedBy) ?? 'Personal sin nombre en el alcance';
              return (
                <li
                  key={triage.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="tabular text-[0.8125rem]">
                      {triage.at === null
                        ? 'sin hora registrada'
                        : formatSedeStamp(triage.at, sede.timezone)}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(triage.values).map(([key, value]) => (
                        <Badge key={`${triage.id}-${key}`} variant="outline">
                          {vitalValueLabel(key)}: {String(value)}
                        </Badge>
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {episodeName} · {recorderName}
                    </span>
                    <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                      {triage.episodeId === null
                        ? 'sin episodio'
                        : `episodio ${triage.episodeId.slice(0, 8)}…`}
                      {' · registró '}
                      {triage.recordedBy.slice(0, 8)}…
                    </span>
                  </div>
                </li>
              );
            })}
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
  // B2 custom keys of `values`: `active` definitions of (salud, triage).
  // A failed read degrades to no section — the API still enforces on arrival.
  const [customDefs, setCustomDefs] = useState<readonly CustomFieldDef[]>([]);
  const [customValues, setCustomValues] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    requestJson(
      '/custom-fields?module=salud&entity=triage&status=active',
      z.array(customFieldDefSchema),
      { signal: controller.signal },
    )
      .then((rows) => {
        if (!active) return;
        setCustomDefs((rows ?? []).filter((def) => def.status === 'active'));
      })
      .catch(() => {
        if (active) setCustomDefs([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const checks: Readonly<Record<string, FieldCheck>> = {
    episodeId: checkOptionalUuidField('episodeId', episodeId),
    ...Object.fromEntries(
      VITAL_FIELDS.map(({ key }) => [
        key,
        (vitals[key] ?? '').trim() === '' ? null : checkNumberField(key, vitals[key] ?? ''),
      ]),
    ),
    note: checkOptionalText('note', note, 280),
    ...Object.fromEntries(
      customDefs.map((def) => [
        `custom.${def.code}`,
        checkCustomField(def, customValues[def.code] ?? ''),
      ]),
    ),
  };
  const hasVital = VITAL_FIELDS.some((field) => (vitals[field.key] ?? '').trim() !== '');

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null || !hasVital) return;

    const values: Record<string, number | string | boolean> = {};
    for (const { key } of VITAL_FIELDS) {
      const raw = (vitals[key] ?? '').trim();
      if (raw !== '') values[key] = Number(raw);
    }
    if (note.trim() !== '') values.note = note.trim();
    Object.assign(values, parseCustomValues(customDefs, customValues));

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
      setCustomValues({});
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
          <Select
            id="triage-episode"
            value={episodeId}
            onChange={(event) => setEpisodeId(event.target.value)}
            onBlur={() => setTouched(true)}
          >
            <option value="">Sin episodio</option>
            {episodes.map((episode) => {
              const date = (episode.openedAt ?? '').slice(0, 10);
              return (
                <option key={episode.id} value={episode.id}>
                  {episode.specialty}{date === '' ? '' : ` · ${date}`} ·{' '}
                  {episode.status === 'open' ? 'abierto' : 'cerrado'}
                </option>
              );
            })}
          </Select>
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

      {customDefs.length === 0 ? null : (
        <div className="flex flex-col gap-4 rounded-md border border-border p-4">
          <p className="text-xs text-muted-foreground">
            Campos personalizados del tenant. Viajan dentro de{' '}
            <code className="font-mono">values</code> y el API los valida por tipo.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {customDefs.map((def) => {
              const field = `custom.${def.code}`;
              const raw = customValues[def.code] ?? '';
              return (
                <div key={def.code} className="flex flex-col gap-1.5">
                  <label htmlFor={`triage-custom-${def.code}`} className="text-[0.8125rem] font-medium">
                    {def.code}
                    {def.required ? ' *' : ''}
                  </label>
                  {def.type === 'boolean' ? (
                    <input
                      id={`triage-custom-${def.code}`}
                      type="checkbox"
                      className="h-4 w-4"
                      checked={raw === 'true'}
                      onChange={(event) =>
                        setCustomValues((current) => ({
                          ...current,
                          [def.code]: event.target.checked ? 'true' : 'false',
                        }))
                      }
                      onBlur={() => setTouched(true)}
                    />
                  ) : (
                    <Input
                      id={`triage-custom-${def.code}`}
                      autoComplete="off"
                      inputMode={def.type === 'number' ? 'decimal' : undefined}
                      placeholder={def.type === 'date' ? 'AAAA-MM-DD' : undefined}
                      value={raw}
                      onChange={(event) =>
                        setCustomValues((current) => ({
                          ...current,
                          [def.code]: event.target.value,
                        }))
                      }
                      onBlur={() => setTouched(true)}
                      {...fieldStateProps(checks[field] ?? null, touched)}
                    />
                  )}
                  <FieldMessage issue={checks[field] ?? null} touched={touched} validLabel="Dato aceptado." />
                </div>
              );
            })}
          </div>
        </div>
      )}

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
