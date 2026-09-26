'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  OBRAS_BOARD_POLL_DEFAULT_MS,
  OBRAS_BOARD_POLL_MAX_MS,
  OBRAS_BOARD_POLL_MIN_MS,
  clampObrasBoardPollMs,
  type CompanyBoard,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FailurePanel } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatQuantity } from '@/lib/format';
import { getCompanyBoard } from '@/lib/obras-api';
import {
  downloadCompanyBoardCsv,
  fetchComparedCompanyBoard,
  lastCompanyBoardScope,
  readCompanyBoardCache,
  writeCompanyBoardCache,
  type ComparedCompanyBoard,
  type ObrasBoardCompareMode,
} from '@/lib/obras-board-cache';
import { saveTextFile } from '@/lib/salud-download';
import { formatElapsed, formatUtcDateLong } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * Tablero de empresa: sites and aggregated progress over the membership subtree.
 *
 * The read is `GET /v1/obras/board`, which takes no parameter: the API
 * aggregates the caller's scope and echoes the org node it used. That is why the
 * cache key is built from the *answer* (`orgNodeId`, `date`) and not from a
 * request field, and why the screen has no sede field — inventing one would
 * suggest a scope the endpoint does not accept.
 *
 * Two §6.2 blocks do not exist in MVP1 and the API states them instead of
 * reporting a zero: cobranza (it belongs to the billing vertical) and uso por
 * módulo (no per-module usage metric is recorded). The panel renders those
 * sentences verbatim, because a zero and a "not applicable" are different facts.
 */
export function CompanyBoardPanel({ className }: { readonly className?: string }) {
  const [pollMs, setPollMs] = useState(OBRAS_BOARD_POLL_DEFAULT_MS);
  const [compare, setCompare] = useState<ObrasBoardCompareMode>('off');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<ApiFailure | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The endpoint takes no parameter, so the resource key is a constant: the
  // scope is whatever the API aggregated. The cache is consulted through the
  // identity of the *last* read, which the cache module remembers.
  const lastScope = lastCompanyBoardScope();
  const board = useResource<CompanyBoard>(
    'obras-company-board',
    (signal) => getCompanyBoard(signal),
    {
      initialData:
        lastScope === null
          ? null
          : readCompanyBoardCache(lastScope.orgNodeId, lastScope.date),
    },
  );

  const reloadSilently = board.reloadSilently;
  const data = board.data;

  // One endpoint, one identity: the answer always belongs to the key on screen.
  const visibleBoard = data;

  // Comparison (`GET /v1/obras/board?compare=previous-week`). `off` resolves
  // to `null` without a request; the company KPIs are scope-state, not
  // day-state, so the drift reads 0 within one request — the envelope still
  // carries the labeled previous date for external BI series.
  const compared = useResource<ComparedCompanyBoard | null>(
    `obras-company-compare|${compare}`,
    (signal) =>
      compare === 'off' ? Promise.resolve(null) : fetchComparedCompanyBoard(signal),
  );
  const delta = compared.data?.delta ?? null;
  const previousDate = compared.data?.previous.date ?? null;

  useEffect(() => {
    // Storing the echoed identity is what makes the cache useful on the next
    // poll and on a return to the screen.
    if (data !== null) writeCompanyBoardCache(data);
  }, [data]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) reloadSilently();
    }, pollMs);
    const onVisibility = (): void => {
      if (!document.hidden) reloadSilently();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollMs, reloadSilently]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const setPollPeriod = useCallback((value: number) => setPollMs(clampObrasBoardPollMs(value)), []);

  const downloadCsv = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const file = await downloadCompanyBoardCsv();
      saveTextFile(file.filename, file.csv);
    } catch (error) {
      setDownloadError(classifyApiError(error));
    } finally {
      setDownloading(false);
    }
  }, []);

  return (
    <Card className={className} id="tablero-empresa">
      <CardHeader>
        <CardEyebrow>Tablero de empresa</CardEyebrow>
        <CardTitle as="h2">Obras y avance agregado del alcance</CardTitle>
        <CardDescription>
          El API agrega todo el subárbol de la membresía y devuelve el nodo que usó; la pantalla no
          envía sede porque el endpoint no la acepta. La lectura automática va dentro de la banda de
          5 a 15 minutos de obras, con caché de cliente de un minuto por nodo y día.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Cadence selector: the active option is exposed as a pressed state so
            the choice is programmatically determinable, not colour-only. */}
        <div role="group" aria-label="Lectura automática" className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Lectura automática:</span>
          {[
            { label: '5 min', value: OBRAS_BOARD_POLL_MIN_MS },
            { label: '10 min', value: OBRAS_BOARD_POLL_DEFAULT_MS },
            { label: '15 min', value: OBRAS_BOARD_POLL_MAX_MS },
          ].map((option) => (
            <Button
              key={option.value}
              variant={pollMs === option.value ? 'outline' : 'ghost'}
              size="sm"
              aria-pressed={pollMs === option.value}
              onClick={() => setPollPeriod(option.value)}
            >
              {option.label}
            </Button>
          ))}
          <span className="tabular ml-auto text-xs text-muted-foreground">
            {board.loading
              ? 'leyendo…'
              : board.loadedAt === null
                ? 'sin lectura'
                : `actualizado ${formatElapsed((now - board.loadedAt) / 1000)}`}
          </span>
          <Button variant="ghost" size="sm" onClick={board.reload} disabled={board.loading}>
            Actualizar
          </Button>
        </div>

        {/* Comparison and export: the drift reads `?compare=previous-week` and
            the CSV carries the same aggregate as the JSON board. */}
        <div role="group" aria-label="Comparativa y descarga" className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Comparativa:</span>
          {[
            { label: 'Sin comparativa', value: 'off' as ObrasBoardCompareMode },
            { label: 'Semana anterior (−7 d)', value: 'previous-week' as ObrasBoardCompareMode },
          ].map((option) => (
            <Button
              key={option.value}
              variant={compare === option.value ? 'outline' : 'ghost'}
              size="sm"
              aria-pressed={compare === option.value}
              onClick={() => setCompare(option.value)}
            >
              {option.label}
            </Button>
          ))}
          <Button variant="outline" size="sm" onClick={downloadCsv} disabled={downloading}>
            {downloading ? 'Descargando…' : 'Descargar CSV'}
          </Button>
          {compare !== 'off' && compared.loading ? (
            <span className="text-xs text-muted-foreground">leyendo comparativa…</span>
          ) : null}
        </div>

        {compared.failure !== null && compare !== 'off' ? (
          <FailurePanel
            title="No se pudo leer la comparativa"
            failure={compared.failure}
            onRetry={compared.reload}
          />
        ) : null}
        {downloadError !== null ? (
          <FailurePanel
            title="No se pudo descargar el CSV"
            failure={downloadError}
            onRetry={() => void downloadCsv()}
          />
        ) : null}

        {board.failure !== null ? (
          <FailurePanel
            title="No se pudo leer el tablero de empresa"
            failure={board.failure}
            onRetry={board.reload}
          />
        ) : null}

        {board.loading && visibleBoard === null ? <CompanySkeleton /> : null}

        {visibleBoard === null ? null : (
          <div className="flex flex-col gap-5">
            <p className="tabular text-xs text-muted-foreground">
              Nodo {visibleBoard.orgNodeId} · día {formatUtcDateLong(visibleBoard.date)}
            </p>

            <div className="grid gap-4 sm:grid-cols-4">
              <Kpi label="Obras en el alcance" value={String(visibleBoard.sites.total)} delta={deltaText(delta, 'sitesTotal', previousDate)} />
              <Kpi label="En ejecución" value={String(visibleBoard.sites.active)} delta={deltaText(delta, 'sitesActive', previousDate)} />
              <Kpi label="Planificadas" value={String(visibleBoard.sites.planned)} delta={deltaText(delta, 'sitesPlanned', previousDate)} />
              <Kpi label="Cerradas" value={String(visibleBoard.sites.closed)} delta={deltaText(delta, 'sitesClosed', previousDate)} />
            </div>

            <div className="grid gap-4 sm:grid-cols-4">
              <Kpi label="Cantidad prevista" value={formatQuantity(visibleBoard.progress.qtyPlanned)} delta={deltaText(delta, 'qtyPlanned', previousDate)} />
              <Kpi label="Cantidad ejecutada" value={formatQuantity(visibleBoard.progress.qtyDone)} delta={deltaText(delta, 'qtyDone', previousDate)} />
              <Kpi label="Cantidad restante" value={formatQuantity(visibleBoard.progress.qtyRemaining)} delta={deltaText(delta, 'qtyRemaining', previousDate)} />
              <Kpi label="Avance agregado" value={`${visibleBoard.progress.percent} %`} delta={deltaText(delta, 'percent', previousDate)} />
            </div>
            {compare !== 'off' && previousDate !== null ? (
              <p className="text-xs text-muted-foreground">
                Comparado con el {formatUtcDateLong(previousDate)}: los KPI de empresa agregan el
                estado del alcance, no un día, así que la deriva dentro de una lectura es 0 por
                construcción; la fecha anterior rotula la serie para BI externo.
              </p>
            ) : null}

            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-[0.8125rem] font-medium">KPI no aplicables</h3>
              <p className="text-xs text-muted-foreground">
                El API declara estos dos bloques como no aplicables en lugar de reportarlos como
                cero, porque un cero y una ausencia de dato no son el mismo hecho:
              </p>
              <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">cobranza</dt>
                <dd>{visibleBoard.notApplicable.collections}</dd>
                <dt className="text-muted-foreground">uso por módulo</dt>
                <dd>{visibleBoard.notApplicable.moduleUsage}</dd>
              </dl>
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Kpi({ label, value, delta }: { readonly label: string; readonly value: string; readonly delta?: string }) {
  return (
    <div className={cn('rounded-md border border-border bg-card px-3 py-2.5')}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular text-lg font-medium">{value}</p>
      {delta === undefined ? null : (
        <p className="tabular text-xs text-muted-foreground">{delta}</p>
      )}
    </div>
  );
}

/** Drift of one KPI (`current − previous`), or `undefined` when not comparing. */
function deltaText(
  delta: Readonly<Record<string, number>> | null,
  key: string,
  previousDate: string | null,
): string | undefined {
  if (delta === null || previousDate === null) return undefined;
  const value = delta[key];
  if (value === undefined) return undefined;
  const signed = value > 0 ? `+${value}` : String(value);
  return `${signed} vs ${previousDate}`;
}

function CompanySkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-5">
      <Skeleton className="ob-shimmer h-3 w-56" />
      <div className="grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="ob-shimmer h-16 w-full rounded-md" delay={index * 90} />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="ob-shimmer h-16 w-full rounded-md" delay={index * 90} />
        ))}
      </div>
    </div>
  );
}
