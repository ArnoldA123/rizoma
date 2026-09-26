'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  SPECIALTY_MAX,
  checkOptionalUuidField,
  checkRequiredText,
  firstIssue,
  type EpisodeRecord,
  type FieldCheck,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { EPISODE_STATUS_LABELS } from '@/lib/labels';
import { closeEpisode, createEpisode } from '@/lib/salud-api';
import { listUsers } from '@/lib/users-api';
import { episodesOfPatient } from '@/lib/salud-select';
import { formatUtcDate, utcDateOf } from '@/lib/salud-time';
import type { Resource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * Episodes panel of the ficha 360.
 *
 * The list is owned by the page (`useResource` in `PatientFile`) and handed down,
 * so the ficha reads `GET /v1/salud/episodes` exactly once even though two panels
 * need it — the panel below and the episode selector of the consent form. The
 * patient filter is local because the endpoint takes no `?patient=`.
 *
 * Closing is **optimistic**, which is the interesting part of this panel: the row
 * flips to `closed` on the click, and if the API refuses, the previous state is
 * restored and the row plays the rollback animation (`sd-revert`) while the
 * failure panel names the `code`, `reason` and `traceId`. That is what makes an
 * optimistic UI honest — the revert is visible, not silent.
 */
export interface EpisodesPanelProps {
  readonly patientId: string;
  /** `episode.write` — only médico holds it in the MVP1 matrix. */
  readonly canWrite: boolean;
  /** Shared episode list of the ficha (page-owned). */
  readonly resource: Resource<EpisodeRecord[]>;
  readonly className?: string;
}

export function EpisodesPanel({ patientId, canWrite, resource, className }: EpisodesPanelProps) {
  const [writeFailure, setWriteFailure] = useState<ApiFailure | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [revertedId, setRevertedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // The rollback flash is a one-shot animation: the flag clears itself so a
  // second failure on the same row animates again.
  useEffect(() => {
    if (revertedId === null) return;
    const timer = window.setTimeout(() => setRevertedId(null), 600);
    return () => window.clearTimeout(timer);
  }, [revertedId]);

  const rows = episodesOfPatient(resource.data ?? [], patientId);

  async function handleClose(episode: EpisodeRecord): Promise<void> {
    const snapshot = resource.data ?? [];
    setWriteFailure(null);
    setBusyId(episode.id);
    // Optimistic: the row already reads `closed`, with the timestamp the API is
    // about to stamp.
    resource.setData(
      snapshot.map((row) =>
        row.id === episode.id ? { ...row, status: 'closed', closedAt: new Date().toISOString() } : row,
      ),
    );
    try {
      const updated = await closeEpisode(episode.id);
      resource.setData((current) =>
        (current ?? []).map((row) => (row.id === updated.id ? updated : row)),
      );
    } catch (error) {
      // Revert to the exact previous array, then flash the row.
      resource.setData(snapshot);
      setRevertedId(episode.id);
      setWriteFailure(classifyApiError(error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Episodios clínicos</CardEyebrow>
        <CardTitle as="h2">Episodios del paciente</CardTitle>
        <CardDescription>
          Estado del episodio a la vista, con apertura y cierre. El cierre es optimista: la fila
          cambia de inmediato y, si el API lo rechaza, vuelve a su estado anterior con una animación
          de reversión y el envelope del error.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            {resource.loading
              ? 'leyendo…'
              : `${rows.length} episodio${rows.length === 1 ? '' : 's'} de este paciente`}
          </span>
          <Button variant="ghost" size="sm" onClick={resource.reload} disabled={resource.loading}>
            Actualizar
          </Button>
          {canWrite ? (
            <Button
              variant={formOpen ? 'ghost' : 'outline'}
              size="sm"
              className="ml-auto"
              onClick={() => setFormOpen((open) => !open)}
            >
              {formOpen ? 'Cerrar formulario' : 'Abrir episodio'}
            </Button>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground">
              Sin <code className="font-mono">episode.write</code>: lectura solamente.
            </span>
          )}
        </div>

        {formOpen && canWrite ? (
          <EpisodeForm
            patientId={patientId}
            onOpened={(episode) => {
              resource.setData((current) => [episode, ...(current ?? [])]);
              setSavedAt(Date.now());
              setFormOpen(false);
            }}
          />
        ) : null}

        {resource.data === null ? null : (
          <WriteResult
            failure={writeFailure}
            success={savedAt === null ? null : 'Episodio abierto y registrado en la auditoría del API.'}
          />
        )}

        {resource.loading ? <SkeletonRows rows={3} /> : null}

        {!resource.loading && resource.failure !== null ? (
          <FailurePanel
            title="No se pudieron leer los episodios"
            failure={resource.failure}
            onRetry={resource.reload}
          />
        ) : null}

        {!resource.loading && resource.failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin episodios"
            title="Este paciente no tiene episodios"
            description="El API respondió con una lista válida: no hay episodios para esta ficha en el alcance actual. Un episodio se abre desde aquí cuando el rol tiene episode.write."
          />
        ) : null}

        {rows.length === 0 ? null : (
          <ul className="flex flex-col">
            {rows.map((episode) => {
              const open = episode.status === 'open';
              return (
                <li
                  key={episode.id}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0',
                    revertedId === episode.id && 'sd-revert',
                  )}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[0.9375rem] font-medium">{episode.specialty}</span>
                      <Badge variant={open ? 'accent' : 'neutral'}>
                        {EPISODE_STATUS_LABELS[episode.status] ?? episode.status}
                      </Badge>
                    </div>
                    <span className="tabular font-mono text-xs text-muted-foreground">
                      abierto {formatUtcDate(utcDateOf(episode.openedAt) ?? '')}
                      {episode.closedAt === null
                        ? ' · sin cierre'
                        : ` · cerrado ${formatUtcDate(utcDateOf(episode.closedAt) ?? '')}`}
                      {' · profesional '}
                      {episode.professionalId.slice(0, 8)}…
                    </span>
                  </div>

                  {canWrite && open ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === episode.id}
                      onClick={() => void handleClose(episode)}
                    >
                      {busyId === episode.id ? 'Cerrando…' : 'Cerrar episodio'}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface EpisodeFormProps {
  readonly patientId: string;
  readonly onOpened: (episode: EpisodeRecord) => void;
}

/** Opening form: specialty is required, the professional defaults to the caller. */
function EpisodeForm({ patientId, onOpened }: EpisodeFormProps) {
  const [specialty, setSpecialty] = useState('');
  const [professionalId, setProfessionalId] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [professionalItems, setProfessionalItems] = useState<readonly EntityItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
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
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const checks: Readonly<Record<string, FieldCheck>> = {
    specialty: checkRequiredText('specialty', specialty, SPECIALTY_MAX),
    professionalId: checkOptionalUuidField('professionalId', professionalId),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const episode = await createEpisode({
        patientId,
        specialty: specialty.trim(),
        ...(professionalId.trim() === '' ? {} : { professionalId: professionalId.trim() }),
      });
      setSpecialty('');
      setProfessionalId('');
      setTouched(false);
      onOpened(episode);
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
          <label htmlFor="episode-specialty" className="text-[0.8125rem] font-medium">
            Especialidad
          </label>
          <Input
            id="episode-specialty"
            value={specialty}
            maxLength={SPECIALTY_MAX}
            onChange={(event) => setSpecialty(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.specialty ?? null, touched)}
          />
          <FieldMessage
            issue={checks.specialty ?? null}
            touched={touched}
            validLabel="Dato aceptado."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <EntitySelector
            label="Profesional"
            items={professionalItems}
            value={professionalId === '' ? null : professionalId}
            onChange={(id) => {
              setProfessionalId(id ?? '');
              setTouched(true);
            }}
            placeholder="Vacío: usted mismo"
            searchPlaceholder="Buscar por nombre…"
          />
          <FieldMessage
            issue={checks.professionalId ?? null}
            touched={touched}
            validLabel="Dato aceptado."
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" type="submit" size="sm" disabled={saving}>
          {saving ? 'Abriendo…' : 'Abrir episodio'}
        </Button>
        <span className="text-xs text-muted-foreground">
          El API asigna <code className="font-mono">professional_id</code> al usuario de la sesión
          cuando el campo queda vacío.
        </span>
      </div>

      {failure === null ? null : <FailurePanel title="El episodio no se abrió" failure={failure} />}
    </form>
  );
}
