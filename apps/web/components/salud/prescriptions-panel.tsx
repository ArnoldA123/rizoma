'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DraftIssue, EpisodeRecord, FieldCheck, PrescriptionRecord } from '@rizoma/contracts';
import { checkRequiredText, checkUuidField, firstIssue } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createPrescription, listPrescriptions } from '@/lib/salud-api';

/**
 * Prescription panel of the ficha 360 — template-based orders (§2.3).
 *
 * The panel owns the history read and the create write. The patient is never
 * typed: it is derived from the episode server-side, so the form asks for an
 * episode, a template and at least one line. The status transitions
 * (`draft → issued`, `cancelled`) arrive in a later slice; this panel renders
 * the status the API stored without offering a transition it cannot fulfil.
 */
export interface PrescriptionsPanelProps {
  readonly patientId: string;
  /** Episodes of this patient, for the episode the order belongs to. */
  readonly episodes: readonly EpisodeRecord[];
  /** `episode.write` — creating an order requires it. */
  readonly canWrite: boolean;
  readonly className?: string;
}

/** `prescriptions.status`, as the panel names it (copy lives here, rule in contracts). */
const PRESCRIPTION_STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  issued: 'Emitida',
  cancelled: 'Anulada',
};

function prescriptionStatusVariant(
  status: string,
): 'neutral' | 'outline' | 'accent' | 'tinted' | 'danger' {
  if (status === 'issued') return 'tinted';
  if (status === 'cancelled') return 'danger';
  return 'outline';
}

export function PrescriptionsPanel({
  patientId,
  episodes,
  canWrite,
  className,
}: PrescriptionsPanelProps) {
  const [prescriptions, setPrescriptions] = useState<PrescriptionRecord[] | null>(null);
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
    listPrescriptions(patientId, controller.signal)
      .then((rows) => {
        if (!active) return;
        setPrescriptions(rows);
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

  const rows = prescriptions ?? [];

  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Receta</CardEyebrow>
        <CardTitle as="h2">Recetas del paciente</CardTitle>
        <CardDescription>
          Órdenes por plantilla con sus líneas. El paciente de cada orden lo deriva el API
          desde el episodio, así que el formulario nunca lo pide.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            {loading ? 'leyendo…' : `${rows.length} receta${rows.length === 1 ? '' : 's'}`}
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
              {formOpen ? 'Cerrar formulario' : 'Crear receta'}
            </Button>
          ) : (
            <span className="ml-auto text-xs text-muted-foreground">
              Sin <code className="font-mono">episode.write</code>: lectura solamente.
            </span>
          )}
        </div>

        {formOpen && canWrite ? (
          <PrescriptionForm
            episodes={episodes}
            onCreated={(created) => {
              setPrescriptions((current) => [created, ...(current ?? [])]);
              setWriteFailure(null);
              setSuccess('Receta creada en borrador y registrada en la auditoría del API.');
              setFormOpen(false);
            }}
          />
        ) : null}

        {prescriptions === null ? null : <WriteResult failure={writeFailure} success={success} />}

        {loading ? <SkeletonRows rows={2} /> : null}

        {!loading && readFailure !== null ? (
          <FailurePanel
            title="No se pudieron leer las recetas"
            failure={readFailure}
            onRetry={reload}
          />
        ) : null}

        {!loading && readFailure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin recetas"
            title="Este paciente no tiene recetas registradas"
            description="El API respondió con una lista válida y vacía. La receta se crea sobre un episodio abierto cuando el rol tiene episode.write."
          />
        ) : null}

        {rows.length === 0 ? null : (
          <ul className="flex flex-col">
            {rows.map((prescription) => (
              <li
                key={prescription.id}
                className="flex flex-col gap-2 border-b border-border py-3.5 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[0.8125rem]">{prescription.templateCode}</span>
                  <Badge variant={prescriptionStatusVariant(prescription.status)}>
                    {PRESCRIPTION_STATUS_LABELS[prescription.status] ?? prescription.status}
                  </Badge>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    episodio {prescription.episodeId.slice(0, 8)}…
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  {prescription.items.map((item, index) => (
                    <li key={`${prescription.id}-${index}`} className="text-[0.8125rem]">
                      {item.description}
                      <span className="text-muted-foreground">
                        {[item.dose, item.frequency]
                          .filter((part) => part !== undefined)
                          .join(' · ')}
                        {item.quantity === undefined ? '' : ` · cant. ${item.quantity}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

interface PrescriptionLine {
  readonly description: string;
  readonly quantity: string;
  readonly dose: string;
  readonly frequency: string;
}

const EMPTY_LINE: PrescriptionLine = { description: '', quantity: '', dose: '', frequency: '' };

interface PrescriptionFormProps {
  readonly episodes: readonly EpisodeRecord[];
  readonly onCreated: (prescription: PrescriptionRecord) => void;
}

/** Create form: an open episode, a template and at least one ordered line. */
function PrescriptionForm({ episodes, onCreated }: PrescriptionFormProps) {
  const [episodeId, setEpisodeId] = useState('');
  const [templateCode, setTemplateCode] = useState('receta.general');
  const [lines, setLines] = useState<readonly PrescriptionLine[]>([EMPTY_LINE]);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  function quantityCheck(index: number, value: string): FieldCheck {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const issue: DraftIssue = { field: `lines.${index}.quantity`, code: 'invalid_amount' };
    if (!/^\d+$/.test(trimmed)) return issue;
    return Number(trimmed) > 0 ? null : issue;
  }

  const checks: Readonly<Record<string, FieldCheck>> = {
    episodeId: checkUuidField('episodeId', episodeId),
    templateCode: checkRequiredText('templateCode', templateCode, 120),
    ...Object.fromEntries(
      lines.flatMap((line, index) => [
        [`lines.${index}.description`, checkRequiredText(`lines.${index}.description`, line.description, 280)],
        [`lines.${index}.quantity`, quantityCheck(index, line.quantity)],
      ]),
    ),
  };

  function setLine(index: number, patch: Partial<PrescriptionLine>): void {
    setLines((current) => current.map((line, currentIndex) => (currentIndex === index ? { ...line, ...patch } : line)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const created = await createPrescription({
        episodeId: episodeId.trim(),
        templateCode: templateCode.trim(),
        items: lines.map((line) => ({
          description: line.description.trim(),
          ...(line.quantity.trim() === '' ? {} : { quantity: Number(line.quantity.trim()) }),
          ...(line.dose.trim() === '' ? {} : { dose: line.dose.trim() }),
          ...(line.frequency.trim() === '' ? {} : { frequency: line.frequency.trim() }),
        })),
      });
      setEpisodeId('');
      setTemplateCode('receta.general');
      setLines([EMPTY_LINE]);
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
          <label htmlFor="prescription-episode" className="text-[0.8125rem] font-medium">
            Episodio
          </label>
          {episodes.length === 0 ? (
            <Input
              id="prescription-episode"
              className="font-mono text-xs"
              spellCheck={false}
              placeholder="UUID del episodio"
              value={episodeId}
              onChange={(event) => setEpisodeId(event.target.value)}
              onBlur={() => setTouched(true)}
              {...fieldStateProps(checks.episodeId ?? null, touched)}
            />
          ) : (
            <Select
              id="prescription-episode"
              value={episodeId}
              onChange={(event) => setEpisodeId(event.target.value)}
              onBlur={() => setTouched(true)}
            >
              <option value="">Seleccione un episodio</option>
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
          <label htmlFor="prescription-template" className="text-[0.8125rem] font-medium">
            Plantilla
          </label>
          <Input
            id="prescription-template"
            className="font-mono text-xs"
            value={templateCode}
            maxLength={120}
            onChange={(event) => setTemplateCode(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.templateCode ?? null, touched)}
          />
          <FieldMessage
            issue={checks.templateCode ?? null}
            touched={touched}
            validLabel="Dato aceptado."
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {lines.map((line, index) => (
          <div key={`line-${index}`} className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor={`prescription-line-${index}`} className="text-[0.8125rem] font-medium">
                Línea {index + 1}
              </label>
              <Input
                id={`prescription-line-${index}`}
                value={line.description}
                maxLength={280}
                placeholder="Qué se indica"
                onChange={(event) => setLine(index, { description: event.target.value })}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks[`lines.${index}.description`] ?? null, touched)}
              />
              <FieldMessage
                issue={checks[`lines.${index}.description`] ?? null}
                touched={touched}
                validLabel="Dato aceptado."
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`prescription-qty-${index}`} className="text-[0.8125rem] font-medium">
                Cantidad (opcional)
              </label>
              <Input
                id={`prescription-qty-${index}`}
                inputMode="numeric"
                value={line.quantity}
                onChange={(event) => setLine(index, { quantity: event.target.value })}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks[`lines.${index}.quantity`] ?? null, touched)}
              />
              <FieldMessage
                issue={checks[`lines.${index}.quantity`] ?? null}
                touched={touched}
                validLabel="Dato aceptado."
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`prescription-dose-${index}`} className="text-[0.8125rem] font-medium">
                Dosis y frecuencia (opcional)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  id={`prescription-dose-${index}`}
                  value={line.dose}
                  maxLength={120}
                  placeholder="Dosis"
                  onChange={(event) => setLine(index, { dose: event.target.value })}
                />
                <Input
                  id={`prescription-frequency-${index}`}
                  value={line.frequency}
                  maxLength={120}
                  placeholder="Frecuencia"
                  onChange={(event) => setLine(index, { frequency: event.target.value })}
                />
              </div>
            </div>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setLines((current) => [...current, EMPTY_LINE])}
          >
            Agregar línea
          </Button>
          {lines.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setLines((current) => current.slice(0, -1))}
            >
              Quitar última
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" type="submit" size="sm" disabled={saving}>
          {saving ? 'Creando…' : 'Crear receta en borrador'}
        </Button>
        <span className="text-xs text-muted-foreground">
          La receta nace en <code className="font-mono">draft</code> sobre un episodio abierto;
          el API la rechaza si el episodio está cerrado.
        </span>
      </div>

      {failure === null ? null : <FailurePanel title="La receta no se creó" failure={failure} />}
    </form>
  );
}
