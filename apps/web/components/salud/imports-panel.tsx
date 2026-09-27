'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  PATIENTS_CSV_COLUMNS,
  PATIENTS_CSV_REQUIRED_COLUMNS,
  checkUuidField,
  firstIssue,
  importJobIsClean,
  type FieldCheck,
  type ImportJobListItem,
  type ImportJobRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage } from '@/components/ui/field-feedback';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Input } from '@/components/ui/input';
import { MagneticCta } from '@/components/ui/magnetic';
import { EmptyState, FailurePanel } from '@/components/salud/states';
import { DEV_IDENTITY } from '@/lib/config';
import { formatSedeStamp, shortId } from '@/lib/format';
import { useSedeTimezone } from '@/lib/use-sede-timezone';
import { importJobStatusLabel } from '@/lib/labels';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { fetchImportErrorsCsv, getImportJob, importPatientsCsv } from '@/lib/salud-api';
import { listImportJobs } from '@/lib/imports-api';
import { listOrgNodes } from '@/lib/org-api';
import { saveTextFile } from '@/lib/salud-download';
import { cn } from '@/lib/utils';

/**
 * `/salud/imports` — the patients CSV importer.
 *
 * The screen is deliberately a *text* form and not a file input alone: the API
 * takes `{csv, orgNodeId}` as JSON, and its replay key is the SHA-256 of those
 * bytes (§5.4). Reading a local file into the textarea is a convenience of the
 * browser — the file never leaves the machine as a file, it travels as the CSV
 * text the service parses.
 *
 * Three things the panel states instead of hiding:
 *
 *   - **The job is the result.** `rowsOk` / `rowsError` are what the run
 *     produced; a run with refused rows is not a failed run, and the refused rows
 *     are what the errors CSV carries.
 *   - **The errors CSV is a download, not a rendering.** The button re-reads the
 *     job through the proxy (the only path that carries `content-disposition`)
 *     and hands the bytes to the browser. There is no server-side export
 *     endpoint in MVP1, and the screen does not pretend otherwise.
 *   - **A repeated file is one import.** Re-uploading the same bytes answers the
 *     original job — the same `id` and the same errors CSV — because the key is
 *     the file hash, not a per-click random value.
 */
export interface ImportsPanelProps {
  readonly className?: string;
}

type DownloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly filename: string }
  | { readonly kind: 'failure'; readonly failure: ApiFailure };

/** Name of an import job kind, falling back to the raw value. */
const IMPORT_KIND_LABELS: Record<string, string> = {
  patients_csv: 'Pacientes',
};

function importKindLabel(kind: string): string {
  return IMPORT_KIND_LABELS[kind] ?? kind;
}

/**
 * Visible label of a job option: kind, status, date and counters. The id
 * travels as the option value and never reaches the visible text.
 */
function jobItemLabel(row: ImportJobListItem, timezone: string): string {
  return (
    `${importKindLabel(row.kind)} · ${importJobStatusLabel(row.status)} · ` +
    `${formatSedeStamp(row.createdAt, timezone)} · ${row.rowsOk} aceptadas / ${row.rowsError} rechazadas`
  );
}

export function ImportsPanel({ className }: ImportsPanelProps) {
  const [csv, setCsv] = useState('');
  const [orgNodeId, setOrgNodeId] = useState(DEV_IDENTITY.orgNodeId);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [job, setJob] = useState<ImportJobRecord | null>(null);
  const [lookupId, setLookupId] = useState('');
  const [lookupFailure, setLookupFailure] = useState<ApiFailure | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  // Import jobs carry no sede of their own: the rows read in the zone of the
  // selected sede (P4-1d, quotes-panel precedent), Lima fallback meanwhile.
  const sede = useSedeTimezone(orgNodeId !== '' ? orgNodeId : null);
  const [jobRows, setJobRows] = useState<readonly ImportJobListItem[]>([]);
  const jobItems: readonly EntityItem[] = useMemo(
    () => jobRows.map((row) => ({ id: row.id, label: jobItemLabel(row, sede.timezone) })),
    [jobRows, sede.timezone],
  );
  const [jobListFailed, setJobListFailed] = useState(false);
  const [jobsToken, setJobsToken] = useState(0);
  const [sedeItems, setSedeItems] = useState<readonly EntityItem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const checks: Readonly<Record<string, FieldCheck>> = {
    csv: csv.trim() === '' ? { field: 'csv', code: 'required' } : null,
    orgNodeId: checkUuidField('orgNodeId', orgNodeId),
  };

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
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

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listImportJobs({}, controller.signal)
      .then((rows) => {
        if (!active) return;
        setJobRows(rows);
        setJobListFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setJobRows([]);
        setJobListFailed(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [jobsToken]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setCsv(await file.text());
    setTouched(true);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const result = await importPatientsCsv({ csv, orgNodeId: orgNodeId.trim() });
      setJob(result);
      setDownload({ kind: 'idle' });
      setJobsToken((token) => token + 1);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleLookup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLookupFailure(null);
    if (!/^[0-9a-f-]{36}$/i.test(lookupId.trim())) {
      setLookupFailure({
        kind: 'client',
        status: null,
        code: 'client.invalid_uuid',
        reason: null,
        traceId: null,
        message: 'El identificador del job debe ser un UUID.',
        hint: 'Corrija el identificador y vuelva a intentarlo.',
      });
      return;
    }
    setLookupBusy(true);
    try {
      const found = await getImportJob(lookupId.trim());
      setJob(found);
      setDownload({ kind: 'idle' });
    } catch (error) {
      setLookupFailure(classifyApiError(error));
    } finally {
      setLookupBusy(false);
    }
  }

  async function handleDownload(): Promise<void> {
    if (job === null) return;
    setDownload({ kind: 'busy' });
    try {
      const file = await fetchImportErrorsCsv(job.id);
      if (file === null) {
        setDownload({ kind: 'idle' });
        return;
      }
      saveTextFile(file.filename, file.csv);
      setDownload({ kind: 'done', filename: file.filename });
    } catch (error) {
      setDownload({ kind: 'failure', failure: classifyApiError(error) });
    }
  }

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <Card tone="accent">
        <CardHeader>
          <CardEyebrow>Importar pacientes</CardEyebrow>
          <CardTitle as="h2">Carga por CSV</CardTitle>
          <CardDescription>
            El CSV viaja como texto con la sede, y la clave de repetición es el SHA-256 del archivo:
            volver a subir los mismos bytes responde el job original en lugar de importar dos veces.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <div className="flex flex-col gap-1.5">
              <EntitySelector
                label="Sede de la importación"
                items={sedeItems}
                value={orgNodeId === '' ? null : orgNodeId}
                onChange={(id) => {
                  setOrgNodeId(id ?? '');
                  setTouched(true);
                }}
                placeholder="Seleccionar sede…"
                searchPlaceholder="Buscar por nombre…"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                Una fila puede declarar su propio <code className="font-mono">org_node_id</code>; la
                sede de la solicitud es la del resto.
              </p>
              <FieldMessage issue={checks.orgNodeId ?? null} touched={touched} validLabel="Sede aceptada." />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="import-csv" className="text-[0.8125rem] font-medium">
                  Contenido CSV
                </label>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(event) => void handleFile(event)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fileInput.current?.click()}
                    disabled={saving}
                  >
                    Leer archivo local
                  </Button>
                </div>
              </div>
              <textarea
                id="import-csv"
                rows={10}
                spellCheck={false}
                value={csv}
                disabled={saving}
                onChange={(event) => setCsv(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder={`${PATIENTS_CSV_COLUMNS.join(',')}\nPaciente Demo Uno,dni,00000001,1990-01-31,999888777,`}
                aria-invalid={touched && checks.csv !== null ? true : undefined}
                className="w-full rounded-md border border-input bg-card p-3 font-mono text-xs leading-5 text-foreground placeholder:text-muted-foreground disabled:opacity-60"
              />
              <p className="text-xs text-muted-foreground">
                Columnas obligatorias: {PATIENTS_CSV_REQUIRED_COLUMNS.join(', ')}. Columnas leídas:{' '}
                {PATIENTS_CSV_COLUMNS.join(', ')}. Cada fila se inserta en su propio SAVEPOINT, así que
                una fila inválida no aborta el resto del archivo.
              </p>
              <FieldMessage issue={checks.csv ?? null} touched={touched} validLabel="CSV listo para importar." />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <MagneticCta type="submit" disabled={saving}>
                {saving ? 'Importando…' : 'Importar CSV'}
              </MagneticCta>
              <span className="text-xs text-muted-foreground">
                El resumen del job indica filas aceptadas y filas rechazadas.
              </span>
            </div>
          </form>

          {failure === null ? null : (
            <FailurePanel className="mt-4" title="La importación no se ejecutó" failure={failure} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardEyebrow>Detalle del job</CardEyebrow>
          <CardTitle as="h2">Resultado de la importación</CardTitle>
          <CardDescription>
            El job es la evidencia del run: cuántas filas entraron, cuántas se rechazaron y el CSV de
            errores descargable cuando hubo alguna.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {jobListFailed ? (
            <form className="flex flex-wrap items-center gap-3" onSubmit={handleLookup} noValidate>
              <label htmlFor="import-job-id" className="sr-only">
                Identificador del job
              </label>
              <Input
                id="import-job-id"
                className="font-mono text-xs sm:max-w-sm"
                spellCheck={false}
                placeholder="UUID del job"
                value={lookupId}
                onChange={(event) => setLookupId(event.target.value)}
              />
              <Button variant="outline" size="sm" type="submit" disabled={lookupBusy}>
                {lookupBusy ? 'Consultando…' : 'Consultar job'}
              </Button>
              <span className="text-xs text-muted-foreground">
                La lista de jobs no se pudo leer, así que el identificador se escribe a mano. El
                identificador de una carga anterior sigue sirviendo para auditarla.
              </span>
            </form>
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={handleLookup} noValidate>
              <EntitySelector
                label="Job de importación"
                items={jobItems}
                value={lookupId === '' ? null : lookupId}
                onChange={(id) => setLookupId(id ?? '')}
                placeholder="Seleccionar job…"
                searchPlaceholder="Buscar por tipo o estado…"
                disabled={lookupBusy}
                className="min-w-72 flex-1"
              />
              <Button variant="outline" size="sm" type="submit" disabled={lookupBusy}>
                {lookupBusy ? 'Consultando…' : 'Consultar job'}
              </Button>
              <span className="w-full text-xs text-muted-foreground">
                Los jobs más recientes primero. Cada opción indica tipo, estado, fecha y contadores;
                el identificador queda como valor de la opción y nunca se muestra.
              </span>
            </form>
          )}

          {lookupFailure === null ? null : (
            <FailurePanel title="No se pudo leer el job" failure={lookupFailure} />
          )}

          {job === null ? (
            <EmptyState
              eyebrow="Sin job cargado"
              title="Todavía no hay un resultado que mostrar"
              description="Importe un CSV o consulte un job anterior por su identificador. El panel muestra los contadores y los errores descargables, nunca el contenido de las filas importadas."
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={importJobIsClean(job) ? 'tinted' : 'danger'}>
                  {importJobStatusLabel(job.status)}
                </Badge>
                <span className="tabular text-[0.8125rem]">
                  {job.rowsOk} aceptadas · {job.rowsError} rechazadas
                </span>
                <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                  job {job.id} · archivo {shortId(job.fileSha256)}
                </span>
                <span className="tabular ml-auto text-xs text-muted-foreground">
                  {formatSedeStamp(job.createdAt, sede.timezone)}
                </span>
              </div>

              {job.errorsCsv === null ? (
                <p className="text-xs text-muted-foreground">
                  El run no rechazó ninguna fila, así que no hay CSV de errores que descargar.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={download.kind === 'busy'}
                      onClick={() => void handleDownload()}
                    >
                      {download.kind === 'busy' ? 'Preparando…' : 'Descargar CSV de errores'}
                    </Button>
                    {download.kind === 'done' ? (
                      <span role="status" className="sd-rise text-xs text-muted-foreground">
                        Archivo {download.filename} entregado al navegador.
                      </span>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-[0.8125rem] font-medium">Errores del run</span>
                    <pre className="max-h-56 overflow-auto rounded-md border border-border bg-secondary p-3 text-[0.6875rem] leading-5">
                      {job.errorsCsv}
                    </pre>
                  </div>
                </div>
              )}

              {download.kind === 'failure' ? (
                <FailurePanel title="El CSV de errores no se pudo descargar" failure={download.failure} />
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
