'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  BUDGET_LINE_DESCRIPTION_MAX,
  MILESTONE_NAME_MAX,
  checkDateTimeField,
  checkNumberField,
  checkOptionalUuidField,
  checkRequiredText,
  firstIssue,
  type FieldCheck,
  type ProgressEntryRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { LiveField } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatQuantity, formatUtcStamp } from '@/lib/format';
import { createBudgetLine, createMilestone, listProgressEntries, postProgressEntry } from '@/lib/obras-api';
import { dateTimeLocalToUtcIso } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';

/**
 * Avance: líneas de presupuesto, partidas ejecutadas e hitos.
 *
 * The read path here is the vertical's only list of a plan artefact: `GET
 * /v1/obras/progress/entries?site=` returns the posted entries of the site, newest
 * first, capped at 200 rows. Budget lines and milestones have no read endpoint in
 * MVP1, so they are write-only from the web — the site board aggregates the lines
 * it can see (`progress`) and the milestones due within its horizon, and that is
 * where the state of a milestone is read back.
 *
 * Two service rules are mirrored instead of re-invented:
 *
 *   - **An entry is born `posted`** (`postProgress` inserts directly), so there is
 *     no draft to confirm; `reported_by` is stamped from the token subject for the
 *     same reason the form has no author field;
 *   - **a `budgetLineId` must belong to the same site** (`badRequest` otherwise),
 *     which is why the field is optional and the panel says the line has to be one
 *     of this obra's.
 *
 * The primary controls are plain `Button variant="primary"`: the single magnetic
 * CTA of the ficha belongs to the staff panel (W4).
 */
export interface ProgressPanelProps {
  readonly siteId: string;
  /** `site.write` — create budget lines and milestones. */
  readonly canWrite: boolean;
  /** `attendance.mark` — post an executed quantity (still needs the site key). */
  readonly canMark: boolean;
  /** Milestone name picked on the board, prefilled and still editable. */
  readonly milestoneName: string;
  readonly onMilestoneNameChange: (name: string) => void;
  /** Called after a write so the obra board re-reads its progress block. */
  readonly onProgressChanged: () => void;
  readonly className?: string;
}

interface LineDraft {
  description: string;
  itemId: string;
  qtyPlanned: string;
  unitCost: string;
}

interface EntryDraft {
  budgetLineId: string;
  qtyDone: string;
}

const EMPTY_LINE: LineDraft = { description: '', itemId: '', qtyPlanned: '', unitCost: '' };
const EMPTY_ENTRY: EntryDraft = { budgetLineId: '', qtyDone: '' };

export function ProgressPanel({
  siteId,
  canWrite,
  canMark,
  milestoneName,
  onMilestoneNameChange,
  onProgressChanged,
  className,
}: ProgressPanelProps) {
  const [line, setLine] = useState<LineDraft>(EMPTY_LINE);
  const [entry, setEntry] = useState<EntryDraft>(EMPTY_ENTRY);
  const [milestoneDueAt, setMilestoneDueAt] = useState('');
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const entries = useResource<ProgressEntryRecord[]>(`obras-progress:${siteId}`, (signal) =>
    listProgressEntries({ site: siteId }, signal),
  );
  const rows = entries.data ?? [];

  const lineChecks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      description: checkRequiredText('description', line.description, BUDGET_LINE_DESCRIPTION_MAX),
      itemId: checkOptionalUuidField('itemId', line.itemId),
      qtyPlanned: line.qtyPlanned.trim() === '' ? null : checkNumberField('qtyPlanned', line.qtyPlanned),
      unitCost: line.unitCost.trim() === '' ? null : checkNumberField('unitCost', line.unitCost),
    }),
    [line],
  );
  const entryChecks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      budgetLineId: checkOptionalUuidField('budgetLineId', entry.budgetLineId),
      qtyDone: checkNumberField('qtyDone', entry.qtyDone),
    }),
    [entry],
  );
  const milestoneChecks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      name: checkRequiredText('name', milestoneName, MILESTONE_NAME_MAX),
      dueAt: checkDateTimeField('dueAt', milestoneDueAt),
    }),
    [milestoneDueAt, milestoneName],
  );

  const show = (field: string): boolean => touched[field] === true || submitted;

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function start(): void {
    setFailure(null);
    setSuccess(null);
  }

  async function handleLine(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (firstIssue(lineChecks) !== null) return;
    start();
    setSaving(true);
    try {
      const itemId = line.itemId.trim();
      const qtyPlanned = line.qtyPlanned.trim();
      const unitCost = line.unitCost.trim();
      const created = await createBudgetLine({
        siteId,
        itemId: itemId === '' ? null : itemId,
        description: line.description.trim(),
        qtyPlanned: qtyPlanned === '' ? 0 : Number(qtyPlanned),
        unitCost: unitCost === '' ? 0 : Number(unitCost),
      });
      setLine(EMPTY_LINE);
      // The entries list does not carry budget lines; the board's progress block
      // is the read that does, so the line reload is the board's, not this list's.
      onProgressChanged();
      setTouched({});
      setSubmitted(false);
      setSuccess(
        `Línea «${created.description}» creada con ${formatQuantity(created.qtyPlanned)} previstos. Su avance aparece en el tablero de la obra, que es quien agrega el ejecutado de las partidas.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleEntry(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (firstIssue(entryChecks) !== null) return;
    start();
    setSaving(true);
    try {
      const budgetLineId = entry.budgetLineId.trim();
      const created = await postProgressEntry({
        siteId,
        budgetLineId: budgetLineId === '' ? null : budgetLineId,
        qtyDone: Number(entry.qtyDone.trim()),
      });
      setEntry(EMPTY_ENTRY);
      entries.reloadSilently();
      onProgressChanged();
      setTouched({});
      setSubmitted(false);
      setSuccess(
        `Partida de ${formatQuantity(created.qtyDone)} registrada como «${created.status}» (${formatUtcStamp(created.at)}). El autor se toma del token, no del formulario: reported_by es ${created.reportedBy}.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleMilestone(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    if (firstIssue(milestoneChecks) !== null) return;
    const dueAt = dateTimeLocalToUtcIso(milestoneDueAt);
    if (dueAt === null) return;
    start();
    setSaving(true);
    try {
      const created = await createMilestone({ siteId, name: milestoneName.trim(), dueAt });
      onMilestoneNameChange('');
      setMilestoneDueAt('');
      onProgressChanged();
      setTouched({});
      setSubmitted(false);
      setSuccess(
        `Hito «${created.name}» creado con estado «${created.status}» (${formatUtcStamp(created.dueAt)}). El estado lo decide el reloj de la base: una fecha ya pasada se guarda vencida en lugar de rechazarse.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} id="avance-obra">
      <CardHeader>
        <CardEyebrow>Avance</CardEyebrow>
        <CardTitle as="h2">Presupuesto, partidas e hitos</CardTitle>
        <CardDescription>
          La línea de presupuesto declara lo previsto, la partida lo ejecutado y el hito el plazo. El
          tablero de la obra agrega las dos primeras por línea y lista los hitos próximos; esta
          pantalla es la que las escribe.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {canWrite ? (
          <form className="flex flex-col gap-4" onSubmit={handleLine} noValidate>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <LiveField
                id="line-description"
                label="Descripción de la partida"
                issue={lineChecks.description ?? null}
                touched={show('description')}
              >
                <Input
                  id="line-description"
                  maxLength={BUDGET_LINE_DESCRIPTION_MAX}
                  placeholder="Excavación de cimentación"
                  value={line.description}
                  onChange={(event) => setLine((current) => ({ ...current, description: event.target.value }))}
                  onBlur={() => touch('description')}
                />
              </LiveField>
              <LiveField
                id="line-item"
                label="Ítem de almacén (opcional)"
                issue={lineChecks.itemId ?? null}
                touched={show('itemId')}
                hint="El ítem debe pertenecer al tenant; es opcional."
              >
                <Input
                  id="line-item"
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder="UUID del ítem"
                  value={line.itemId}
                  onChange={(event) => setLine((current) => ({ ...current, itemId: event.target.value }))}
                  onBlur={() => touch('itemId')}
                />
              </LiveField>
              <LiveField
                id="line-planned"
                label="Cantidad prevista"
                issue={lineChecks.qtyPlanned ?? null}
                touched={show('qtyPlanned')}
                hint="Vacío equivale a 0."
              >
                <Input
                  id="line-planned"
                  inputMode="decimal"
                  placeholder="120"
                  value={line.qtyPlanned}
                  onChange={(event) => setLine((current) => ({ ...current, qtyPlanned: event.target.value }))}
                  onBlur={() => touch('qtyPlanned')}
                />
              </LiveField>
              <LiveField
                id="line-cost"
                label="Costo unitario"
                issue={lineChecks.unitCost ?? null}
                touched={show('unitCost')}
                hint="La columna guarda dos decimales; el API redondea lo demás."
              >
                <Input
                  id="line-cost"
                  inputMode="decimal"
                  placeholder="0"
                  value={line.unitCost}
                  onChange={(event) => setLine((current) => ({ ...current, unitCost: event.target.value }))}
                  onBlur={() => touch('unitCost')}
                />
              </LiveField>
            </div>
            <div>
              <Button variant="primary" size="sm" type="submit" disabled={saving}>
                {saving ? 'Creando…' : 'Crear línea de presupuesto'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Su rol no puede crear líneas de presupuesto ni hitos en esta obra: esas opciones no
              se ofrecen. Si necesita este acceso, avise a jefatura o a soporte.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                Copiar detalle
              </summary>
              <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                {`code: obra.scope_denied\nstatus: 403\naction: site.write`}
              </pre>
            </details>
          </div>
        )}

        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[0.8125rem] font-medium">Partidas registradas</span>
            <span className="tabular ml-auto text-xs text-muted-foreground">
              {entries.loading ? 'leyendo…' : `${rows.length} partidas`}
            </span>
            <Button variant="ghost" size="sm" onClick={entries.reload} disabled={entries.loading}>
              Actualizar
            </Button>
          </div>

          {entries.loading ? <EntriesSkeleton /> : null}

          {!entries.loading && entries.failure !== null ? (
            <FailurePanel
              title="No se pudieron leer las partidas de la obra"
              failure={entries.failure}
              onRetry={entries.reload}
            />
          ) : null}

          {!entries.loading && entries.failure === null && rows.length === 0 ? (
            <EmptyState
              eyebrow="Sin partidas"
              title="La obra no tiene partidas registradas"
              description="El API respondió con una lista válida y vacía. Una partida se registra al ejecutar el trabajo; sin partidas, el avance del tablero no tiene numerador y las líneas muestran 0 %."
            />
          ) : null}

          {!entries.loading && entries.failure === null && rows.length > 0 ? (
            <ul className="flex flex-col">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular text-[0.9375rem] font-medium">
                        {formatQuantity(row.qtyDone)}
                      </span>
                      <Badge variant="outline">{row.status}</Badge>
                    </div>
                    <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                      partida {row.id}
                      {row.budgetLineId === null ? ' · sin línea' : ` · línea ${row.budgetLineId}`} ·
                      autor {row.reportedBy}
                    </span>
                  </div>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatUtcStamp(row.at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {canMark ? (
            <form className="flex flex-col gap-4 border-t border-border pt-4" onSubmit={handleEntry} noValidate>
              <p className="text-xs text-muted-foreground">
                Registrar una partida exige <code className="font-mono">attendance.mark</code> y una
                asignación activa a esta obra — gerencia y jefatura de obra quedan exentas por su
                alcance de organización. Si indica una línea, tiene que ser una de esta obra: el API
                rechaza una línea de otra sede.
              </p>
              <div className="grid items-start gap-4 sm:grid-cols-3">
                <LiveField
                  id="entry-line"
                  label="Línea de presupuesto (opcional)"
                  issue={entryChecks.budgetLineId ?? null}
                  touched={show('budgetLineId')}
                >
                  <Input
                    id="entry-line"
                    className="font-mono text-xs"
                    spellCheck={false}
                    placeholder="UUID de la línea"
                    value={entry.budgetLineId}
                    onChange={(event) => setEntry((current) => ({ ...current, budgetLineId: event.target.value }))}
                    onBlur={() => touch('budgetLineId')}
                  />
                </LiveField>
                <LiveField
                  id="entry-qty"
                  label="Cantidad ejecutada"
                  issue={entryChecks.qtyDone ?? null}
                  touched={show('qtyDone')}
                  hint="Admite 0: una partida sin avance también es un hecho registrado."
                >
                  <Input
                    id="entry-qty"
                    inputMode="decimal"
                    placeholder="12"
                    value={entry.qtyDone}
                    onChange={(event) => setEntry((current) => ({ ...current, qtyDone: event.target.value }))}
                    onBlur={() => touch('qtyDone')}
                  />
                </LiveField>
                <div className="flex items-end sm:pt-6">
                  <Button variant="primary" size="sm" type="submit" disabled={saving}>
                    {saving ? 'Registrando…' : 'Registrar partida'}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">
              Su rol no tiene <code className="font-mono">attendance.mark</code>: registrar partidas
              no se ofrece.
            </p>
          )}
        </div>

        {canWrite ? (
          <form className="flex flex-col gap-4 border-t border-border pt-4" onSubmit={handleMilestone} noValidate>
            <div className="grid items-start gap-4 sm:grid-cols-3">
              <LiveField
                id="milestone-name"
                label="Hito"
                issue={milestoneChecks.name ?? null}
                touched={show('name')}
                hint="Se completa al elegir un hito próximo en el tablero."
              >
                <Input
                  id="milestone-name"
                  maxLength={MILESTONE_NAME_MAX}
                  placeholder="Vaciar cimentación"
                  value={milestoneName}
                  onChange={(event) => {
                    onMilestoneNameChange(event.target.value);
                    setSuccess(null);
                  }}
                  onBlur={() => touch('name')}
                />
              </LiveField>
              <LiveField
                id="milestone-due"
                label="Fecha comprometida"
                issue={milestoneChecks.dueAt ?? null}
                touched={show('dueAt')}
                hint="Se interpreta en la hora local del navegador y viaja como instante con offset."
              >
                <Input
                  id="milestone-due"
                  type="datetime-local"
                  value={milestoneDueAt}
                  onChange={(event) => setMilestoneDueAt(event.target.value)}
                  onBlur={() => touch('dueAt')}
                />
              </LiveField>
              <div className="flex items-end sm:pt-6">
                <Button variant="primary" size="sm" type="submit" disabled={saving}>
                  {saving ? 'Creando…' : 'Crear hito'}
                </Button>
              </div>
            </div>
          </form>
        ) : null}

        <WriteResult failure={failure} success={success} />
      </CardContent>
    </Card>
  );
}

function EntriesSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {[0, 1].map((index) => (
        <li key={index} className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
          <div className="flex flex-col gap-2">
            <Skeleton className="ob-shimmer h-3.5 w-24" delay={index * 90} />
            <Skeleton className="ob-shimmer h-2.5 w-64" delay={index * 90 + 60} />
          </div>
          <Skeleton className="ob-shimmer h-3 w-28" delay={index * 90 + 120} />
        </li>
      ))}
    </ul>
  );
}
