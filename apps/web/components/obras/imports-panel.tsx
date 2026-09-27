'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ASSETS_CSV_COLUMNS,
  ASSETS_CSV_REQUIRED_COLUMNS,
  CONSTRUCTION_ROLES,
  IMPORT_JOB_KIND_ASSETS_CSV,
  IMPORT_JOB_KIND_WORKERS_CSV,
  WORKERS_CSV_COLUMNS,
  WORKERS_CSV_REQUIRED_COLUMNS,
  checkUuidField,
  firstIssue,
  importJobIsClean,
  type FieldCheck,
  type ImportJobListItem,
  type ImportJobRecord,
  type ObrasImportKind,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage } from '@/components/ui/field-feedback';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Input } from '@/components/ui/input';
import { MagneticCta } from '@/components/ui/magnetic';
import { FailurePanel } from '@/components/ui/states';
import { DEV_IDENTITY } from '@/lib/config';
import { formatSedeStamp, shortId } from '@/lib/format';
import { useSedeTimezone } from '@/lib/use-sede-timezone';
import { importJobStatusLabel, obrasImportKindLabel } from '@/lib/labels';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { fetchObrasImportErrorsCsv, getImportJob, importAssetsCsv, importWorkersCsv } from '@/lib/obras-api';
import { listImportJobs } from '@/lib/imports-api';
import { listOrgNodes } from '@/lib/org-api';
import { saveTextFile } from '@/lib/salud-download';
import { cn } from '@/lib/utils';

/**
 * `/obras/imports` — workers and equipment CSVs.
 *
 * One form shell for the two importers, because they differ in exactly two
 * things: the endpoint and the column catalogue. The screen shows both, and the
 * columns change with the selected kind instead of the user discovering them from
 * an error.
 *
 * Three properties are inherited from the patients importer (`components/salud/`
 * `imports-panel.tsx`) and are not re-derived here:
 *
 *   - **the job is the result**: `rowsOk` / `rowsError` describe the run, and a
 *     run with refused rows is not a failed run;
 *   - **the CSV travels as text** with a sedes `orgNodeId`, because that is what
 *     the service parses;
 *   - **the replay key is the file hash.** The `Idempotency-Key` sent is the
 *     SHA-256 of the bytes — the same digest the service derives — so re-uploading
 *     a file answers the original job, errors CSV included, instead of importing
 *     twice. The button copy says so.
 *
 * This is the single magnetic CTA of the screen: the imports page has one
 * dominant intent, so the design steer's one-pull-per-screen rule holds.
 */
export interface ObrasImportsPanelProps {
  /** `assignment.write` — may import workers (`POST /imports/workers`). */
  readonly canImportWorkers: boolean;
  /** `site.write` — may import equipment (`POST /imports/assets`). */
  readonly canImportAssets: boolean;
  /** Sede the run defaults to; a row may override it with `org_node_id`. */
  readonly defaultOrgNodeId?: string;
  readonly className?: string;
}

type DownloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'done'; readonly filename: string }
  | { readonly kind: 'failure'; readonly failure: ApiFailure };

const COLUMNS_BY_KIND: Record<ObrasImportKind, readonly string[]> = {
  [IMPORT_JOB_KIND_WORKERS_CSV]: WORKERS_CSV_COLUMNS,
  [IMPORT_JOB_KIND_ASSETS_CSV]: ASSETS_CSV_COLUMNS,
};

const REQUIRED_BY_KIND: Record<ObrasImportKind, readonly string[]> = {
  [IMPORT_JOB_KIND_WORKERS_CSV]: WORKERS_CSV_REQUIRED_COLUMNS,
  [IMPORT_JOB_KIND_ASSETS_CSV]: ASSETS_CSV_REQUIRED_COLUMNS,
};

const SAMPLE_BY_KIND: Record<ObrasImportKind, string> = {
  [IMPORT_JOB_KIND_WORKERS_CSV]: `${WORKERS_CSV_COLUMNS.join(',')}\nAna Demo,ana.demo@example.test,999888777,capataz,`,
  [IMPORT_JOB_KIND_ASSETS_CSV]: `${ASSETS_CSV_COLUMNS.join(',')}\nEX-01,maquinaria,SN-0001,128.5,`,
};

/**
 * Visible label of a job option: kind, status, date and counters. The id
 * travels as the option value and never reaches the visible text.
 */
function jobItemLabel(row: ImportJobListItem, timezone: string): string {
  return (
    `${obrasImportKindLabel(row.kind)} · ${importJobStatusLabel(row.status)} · ` +
    `${formatSedeStamp(row.createdAt, timezone)} · ${row.rowsOk} aceptadas / ${row.rowsError} rechazadas`
  );
}

export function ObrasImportsPanel({
  canImportWorkers,
  canImportAssets,
  defaultOrgNodeId = DEV_IDENTITY.orgNodeId,
  className,
}: ObrasImportsPanelProps) {
  const availableKinds: readonly ObrasImportKind[] = [
    ...(canImportWorkers ? ([IMPORT_JOB_KIND_WORKERS_CSV] as const) : []),
    ...(canImportAssets ? ([IMPORT_JOB_KIND_ASSETS_CSV] as const) : []),
  ];
  const [kind, setKind] = useState<ObrasImportKind>(availableKinds[0] ?? IMPORT_JOB_KIND_WORKERS_CSV);
  const [csv, setCsv] = useState('');
  const [orgNodeId, setOrgNodeId] = useState(defaultOrgNodeId);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [job, setJob] = useState<ImportJobRecord | null>(null);
  const [lookupId, setLookupId] = useState('');
  const [lookupFailure, setLookupFailure] = useState<ApiFailure | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  // Import jobs carry no sede of their own: the rows read in the zone of the
  // selected sede (P4-1d, quotes-panel precedent), Lima fallback meanwhile.
  const sede = useSedeTimezone(orgNodeId !== '' ? orgNodeId : defaultOrgNodeId);
  const [jobRows, setJobRows] = useState<readonly ImportJobListItem[]>([]);
  const jobItems: readonly EntityItem[] = useMemo(
    () => jobRows.map((row) => ({ id: row.id, label: jobItemLabel(row, sede.timezone) })),
    [jobRows, sede.timezone],
  );
  const [jobListFailed, setJobListFailed] = useState(false);
  const [jobsToken, setJobsToken] = useState(0);
  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);
  const [sedeItems, setSedeItems] = useState<readonly EntityItem[]>([]);

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

  const checks: Readonly<Record<string, FieldCheck>> = {
    csv: csv.trim() === '' ? { field: 'csv', code: 'required' } : null,
    orgNodeId: checkUuidField('orgNodeId', orgNodeId),
  };

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
      const body = { csv, orgNodeId: orgNodeId.trim() };
      const result =
        kind === IMPORT_JOB_KIND_WORKERS_CSV
          ? await importWorkersCsv(body)
          : await importAssetsCsv(body);
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
      const file = await fetchObrasImportErrorsCsv(job.id);
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

  const singleKind = availableKinds.length <= 1;

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <Card tone="accent">
        <CardHeader>
          <CardEyebrow>Importar por CSV</CardEyebrow>
          <CardTitle as="h2">Trabajadores y equipos</CardTitle>
          <CardDescription>
            Los dos importadores comparten forma: el CSV viaja como texto con la sede, cada fila se
            inserta en su propio SAVEPOINT y la clave de repetición es el SHA-256 del archivo. Volver
            a subir los mismos bytes responde el job original en lugar de duplicar filas.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {singleKind ? (
            <p className="text-xs text-muted-foreground">
              Su rol habilita {obrasImportKindLabel(kind).toLowerCase()} únicamente:{' '}
              {kind === IMPORT_JOB_KIND_WORKERS_CSV ? (
                <>
                  el CSV de trabajadores exige <code className="font-mono">assignment.write</code>,
                  porque crea usuarios con membresía.
                </>
              ) : (
                <>
                  el CSV de equipos exige <code className="font-mono">site.write</code>, porque crea
                  unidades en el catálogo.
                </>
              )}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[0.8125rem] font-medium">Tipo de carga</span>
              {availableKinds.map((option) => (
                <Button
                  key={option}
                  variant={option === kind ? 'outline' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    setKind(option);
                    setTouched(false);
                  }}
                >
                  {obrasImportKindLabel(option)}
                </Button>
              ))}
              <span className="text-xs text-muted-foreground">
                Trabajadores exige <code className="font-mono">assignment.write</code>; equipos,{' '}
                <code className="font-mono">site.write</code>.
              </span>
            </div>
          )}

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
                sede de la solicitud es la del resto. Una fila fuera del subárbol de la membresía se
                cuenta como error{' '}
                <code className="font-mono">import.org_node_out_of_scope</code>, no como un fallo del
                archivo.
              </p>
              <FieldMessage issue={checks.orgNodeId ?? null} touched={touched} validLabel="Sede aceptada." />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="obras-import-csv" className="text-[0.8125rem] font-medium">
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
                  <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} disabled={saving}>
                    Leer archivo local
                  </Button>
                </div>
              </div>
              <textarea
                id="obras-import-csv"
                rows={8}
                spellCheck={false}
                value={csv}
                disabled={saving}
                onChange={(event) => setCsv(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder={SAMPLE_BY_KIND[kind]}
                aria-invalid={touched && checks.csv !== null ? true : undefined}
                className="w-full rounded-md border border-input bg-card p-3 font-mono text-xs leading-5 text-foreground placeholder:text-muted-foreground disabled:opacity-60"
              />
              <p className="text-xs text-muted-foreground">
                Columnas obligatorias: {REQUIRED_BY_KIND[kind].join(', ')}. Columnas leídas:{' '}
                {COLUMNS_BY_KIND[kind].join(', ')}.
                {kind === IMPORT_JOB_KIND_WORKERS_CSV
                  ? ` Los roles admitidos son ${CONSTRUCTION_ROLES.join(', ')}; un correo ya existente en el tenant se cuenta como fila rechazada.`
                  : ' Un código de equipo ya registrado en el tenant se cuenta como fila rechazada.'}
              </p>
              <FieldMessage issue={checks.csv ?? null} touched={touched} validLabel="CSV listo para importar." />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <MagneticCta type="submit" disabled={saving || availableKinds.length === 0}>
                {saving ? 'Importando…' : `Importar ${obrasImportKindLabel(kind).toLowerCase()}`}
              </MagneticCta>
              <span className="text-xs text-muted-foreground">
                El resumen del job indica filas aceptadas y filas rechazadas, y las rechazadas se
                descargan como CSV.
              </span>
            </div>
          </form>

          {failure === null ? null : (
            <FailurePanel title="La importación no se ejecutó" failure={failure} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardEyebrow>Detalle del job</CardEyebrow>
          <CardTitle as="h2">Resultado de la importación</CardTitle>
          <CardDescription>
            El job es la evidencia del run: cuántas filas entraron, cuántas se rechazaron y el CSV de
            errores descargable cuando hubo alguna. El detalle sigue disponible después de la carga,
            por identificador.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {jobListFailed ? (
            <form className="flex flex-wrap items-center gap-3" onSubmit={handleLookup} noValidate>
              <label htmlFor="obras-import-job-id" className="sr-only">
                Identificador del job
              </label>
              <Input
                id="obras-import-job-id"
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
            <div className="rounded-md border border-border bg-secondary px-4 py-6">
              <p className="text-[0.9375rem] font-medium">Todavía no hay un resultado que mostrar</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Importe un CSV o consulte un job anterior por su identificador. El panel muestra los
                contadores y los errores descargables, nunca el contenido de las filas importadas:
                los datos de trabajadores y equipos quedan en el API.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={importJobIsClean(job) ? 'tinted' : 'danger'}>
                  {importJobStatusLabel(job.status)}
                </Badge>
                <Badge variant="outline">{obrasImportKindLabel(job.kind)}</Badge>
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
                      <span role="status" className="ob-rise text-xs text-muted-foreground">
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
                <FailurePanel
                  title="El CSV de errores no se pudo descargar"
                  failure={download.failure}
                />
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
