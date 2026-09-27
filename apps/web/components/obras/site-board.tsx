'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  OBRAS_BOARD_POLL_DEFAULT_MS,
  OBRAS_BOARD_POLL_MAX_MS,
  OBRAS_BOARD_POLL_MIN_MS,
  clampObrasBoardPollMs,
  type CriticalStockBoard,
  type MaintenanceAssetBoard,
  type SiteBoard,
  type UpcomingMilestoneBoard,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { getSiteBoard } from '@/lib/obras-api';
import {
  downloadSiteBoardCsv,
  fetchComparedSiteBoard,
  readSiteBoardCache,
  siteBoardCacheKey,
  writeSiteBoardCache,
  type ComparedSiteBoard,
  type ObrasBoardCompareMode,
} from '@/lib/obras-board-cache';
import { saveTextFile } from '@/lib/salud-download';
import { formatElapsed, formatUtcDateLong } from '@/lib/salud-time';
import { formatQuantity } from '@/lib/format';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * Tablero de obra: avance por línea, asistencia del día, stock crítico, equipos
 * en mantenimiento e hitos próximos.
 *
 * The read path is where this screen earns its keep, and it is the same shape the
 * salud role boards use, moved to the slower construction cadence:
 *
 *   - **Polling inside the obras band.** `OBRAS_BOARD_POLL_*` fixes 5–15 minutes
 *     (default 10). The timer pauses while the tab is hidden and refreshes once
 *     on return, so a background tab never keeps a primary connection busy;
 *   - **Silent refresh.** A poll replaces the numbers in place — no skeleton
 *     flash every ten minutes — and a failure keeps the last good board on screen
 *     while it names the envelope;
 *   - **Client cache.** `lib/obras-board-cache.ts` serves the last board of the
 *     same `site|día` for a minute, so moving the day does not blank the screen.
 *
 * Every collection is already filtered by the caller scope in the API: the
 * progress lines and the attendance belong to this site, the critical stock and
 * the maintenance assets to the site's org subtree. The screen renders what the
 * schema accepted and computes nothing of its own except the elapsed counter.
 *
 * The three rows that name an artefact the operator acts on — a critical item,
 * a unit in maintenance, a milestone about to fall due — carry a link into the
 * panel that operates it. This board is the only read of the vertical that hands
 * those identifiers back (assets and milestones have no list endpoint in MVP1),
 * so without the link the operations screen would be UUID-typing only.
 */
export interface SiteBoardPanelProps {
  readonly siteId: string;
  /** `YYYY-MM-DD` day the board reads; owned by the ficha. */
  readonly date: string;
  /** Selects a critical item in the stock panel; omitted on a read-only board. */
  readonly onPickItem?: (item: CriticalStockBoard) => void;
  /** Selects a maintenance unit in the equipment panel. */
  readonly onPickAsset?: (asset: MaintenanceAssetBoard) => void;
  /** Prefills the milestone form with an upcoming milestone. */
  readonly onPickMilestone?: (milestone: UpcomingMilestoneBoard) => void;
  /** Bumped by an operation panel so the board re-reads without waiting a poll. */
  readonly refreshToken?: number;
  readonly className?: string;
}

export function SiteBoardPanel({
  siteId,
  date,
  onPickItem,
  onPickAsset,
  onPickMilestone,
  refreshToken = 0,
  className,
}: SiteBoardPanelProps) {
  const [pollMs, setPollMs] = useState(OBRAS_BOARD_POLL_DEFAULT_MS);
  const [compare, setCompare] = useState<ObrasBoardCompareMode>('off');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<ApiFailure | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const cacheKey = siteBoardCacheKey(siteId, date);
  const board = useResource<SiteBoard>(
    cacheKey,
    (signal) => getSiteBoard(siteId, { date }, signal),
    { initialData: readSiteBoardCache(siteId, date) },
  );

  const reloadSilently = board.reloadSilently;
  const data = board.data;

  // Day-vs-−7d comparison (`GET ...?compare=previous-week`). `off` resolves
  // to `null` without a request; any other mode reads fresh, outside the
  // one-minute board cache.
  const compareKey = `compare|${cacheKey}|${compare}`;
  const compared = useResource<ComparedSiteBoard | null>(compareKey, (signal) =>
    compare === 'off'
      ? Promise.resolve(null)
      : fetchComparedSiteBoard(siteId, { date }, signal),
  );
  const delta = compared.data?.delta ?? null;
  const previousDate = compared.data?.previous.date ?? null;

  // A board is only rendered when it belongs to the key on screen: either the
  // answer for that key, or a cached board the hook seeded for it. Otherwise the
  // shaped skeleton shows, so yesterday's numbers never sit under today's
  // heading.
  const dataIsCurrent =
    data !== null && siteBoardCacheKey(data.siteId, data.date) === cacheKey;
  const visibleBoard = data !== null && (dataIsCurrent || !board.loading) ? data : null;

  // The board the API echoed back is what the cache stores, so the key always
  // describes the board it holds.
  useEffect(() => {
    if (data !== null) writeSiteBoardCache(data);
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

  // A write in any operation panel asks for this reload: a consumption has to be
  // visible in «Stock crítico» now, not at the next poll. The token is a counter,
  // so the effect fires once per change and never on the initial mount.
  useEffect(() => {
    if (refreshToken === 0) return;
    reloadSilently();
  }, [refreshToken, reloadSilently]);

  const setPollPeriod = useCallback((value: number) => setPollMs(clampObrasBoardPollMs(value)), []);

  const downloadCsv = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const file = await downloadSiteBoardCsv(siteId, { date });
      saveTextFile(file.filename, file.csv);
    } catch (error) {
      setDownloadError(classifyApiError(error));
    } finally {
      setDownloading(false);
    }
  }, [siteId, date]);

  return (
    <Card className={className} id="tablero-obra">
      <CardHeader>
        <CardEyebrow>Tablero de obra</CardEyebrow>
        <CardTitle as="h2">Avance, asistencia y pendientes del día</CardTitle>
        <CardDescription>
          El tablero de obra resuelve la misma clave de acceso que el personal: asignación activa o
          alcance de organización. El día es el de la sede y el API lo repite en la respuesta, así que el
          encabezado siempre dice el día que se está leyendo.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* The chosen period is stated twice on purpose: visually (the variant)
            and programmatically (`aria-pressed`), so a screen reader can hear
            which cadence is in force instead of inferring it from colour. */}
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

        {/* Comparison and export: the drift reads `?compare=previous-week`
            (day vs −7d, attendance only — progress, stock, assets and
            milestones are scope-state) and the CSV carries the same aggregates
            and `LIMIT` as the JSON board. */}
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
            title="No se pudo leer el tablero de la obra"
            failure={board.failure}
            onRetry={board.reload}
          />
        ) : null}

        {board.loading && visibleBoard === null ? <BoardSkeleton /> : null}

        {visibleBoard === null ? null : (
          <BoardBody
            board={visibleBoard}
            delta={delta}
            previousDate={previousDate}
            onPickItem={onPickItem}
            onPickAsset={onPickAsset}
            onPickMilestone={onPickMilestone}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The five blocks of §6.2, in the order the consolidated bases list them. */
function BoardBody({
  board,
  delta,
  previousDate,
  onPickItem,
  onPickAsset,
  onPickMilestone,
}: {
  readonly board: SiteBoard;
  readonly delta: Readonly<Record<string, number>> | null;
  readonly previousDate: string | null;
  readonly onPickItem?: (item: CriticalStockBoard) => void;
  readonly onPickAsset?: (asset: MaintenanceAssetBoard) => void;
  readonly onPickMilestone?: (milestone: UpcomingMilestoneBoard) => void;
}) {
  const attendance = board.attendance;
  return (
    <div className="flex flex-col gap-5">
      <p className="tabular text-xs text-muted-foreground">
        Obra {board.siteCode} · día {formatUtcDateLong(board.date)}
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-medium">Avance por línea de presupuesto</h3>
        {board.progress.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Sin líneas de presupuesto registradas para esta obra. Una línea se crea en el panel de
            avance de esta ficha y su ejecutado se registra como partida; sin líneas, el bloque es
            válido y vacío.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabular w-full text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Línea
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Previsto
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Ejecutado
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Restante
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Avance
                  </th>
                </tr>
              </thead>
              <tbody>
                {board.progress.map((line) => (
                  <tr key={line.budgetLineId} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-4">{line.description}</td>
                    <td className="py-2 pr-4">{formatQuantity(line.qtyPlanned)}</td>
                    <td className="py-2 pr-4">{formatQuantity(line.qtyDone)}</td>
                    <td className="py-2 pr-4">{formatQuantity(line.qtyRemaining)}</td>
                    <td className="py-2">{line.percent} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-medium">Asistencia del día</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <Kpi label="Registradas" value={String(attendance.registered)} delta={deltaText(delta, 'attendanceRegistered', previousDate)} />
          <Kpi label="Aprobadas" value={String(attendance.approved)} delta={deltaText(delta, 'attendanceApproved', previousDate)} />
          <Kpi label="Rechazadas" value={String(attendance.rejected)} delta={deltaText(delta, 'attendanceRejected', previousDate)} />
          <Kpi label="Ajustadas" value={String(attendance.adjusted)} delta={deltaText(delta, 'attendanceAdjusted', previousDate)} />
        </div>
        <p className="tabular text-xs text-muted-foreground">Total del día: {attendance.total}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-medium">Stock crítico</h3>
        {board.criticalStock.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Ningún ítem por debajo de su stock mínimo en el alcance de la obra. Este bloque lista solo
            lo que está por debajo del mínimo, así que un consumo que deja el ítem por encima no
            aparece aquí: la ausencia es la buena noticia.
          </p>
        ) : (
          <ul className="flex flex-col">
            {board.criticalStock.map((item) => (
              <li
                key={item.itemId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="tabular font-mono text-xs">{item.sku}</span>
                  <span className="text-[0.8125rem]">{item.name}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="tabular text-xs">
                    disponible {formatQuantity(item.available)} {item.unit} · mínimo{' '}
                    {formatQuantity(item.minStock)} {item.unit}
                  </span>
                  {onPickItem === undefined ? null : (
                    <Button variant="ghost" size="sm" onClick={() => onPickItem(item)}>
                      Preparar consumo
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-medium">Equipos en mantenimiento</h3>
        {board.maintenanceAssets.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Ningún equipo en mantenimiento dentro del alcance. Este bloque es, además, la única
            lectura del vertical que devuelve identificadores de equipos: por eso el enlace de cada
            fila es la vía normal para anotar una lectura sin copiar un UUID.
          </p>
        ) : (
          <ul className="flex flex-col">
            {board.maintenanceAssets.map((asset) => (
              <li
                key={asset.assetId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="tabular font-mono text-xs">{asset.code}</span>
                  <span className="text-[0.8125rem]">{asset.kind}</span>
                  <Badge variant="outline">{asset.serial}</Badge>
                </span>
                {onPickAsset === undefined ? null : (
                  <Button variant="ghost" size="sm" onClick={() => onPickAsset(asset)}>
                    Preparar lectura
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[0.8125rem] font-medium">Hitos próximos</h3>
        {board.upcomingMilestones.length === 0 ? (
          <EmptyState
            eyebrow="Sin hitos"
            title="No hay hitos próximos"
            description="El API responde con una lista válida y vacía cuando ningún hito pendiente cae dentro del horizonte del tablero. Un hito se crea en el panel de avance de esta ficha; este bloque es la lectura que lo trae de vuelta."
          />
        ) : (
          <ul className="flex flex-col">
            {board.upcomingMilestones.map((milestone) => (
              <li
                key={milestone.milestoneId}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <span className="text-[0.8125rem]">{milestone.name}</span>
                <span className="flex items-center gap-3">
                  <span className="tabular flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{milestone.status}</Badge>
                    {milestone.dueAt === null ? 'sin fecha' : milestone.dueAt.slice(0, 10)}
                  </span>
                  {onPickMilestone === undefined ? null : (
                    <Button variant="ghost" size="sm" onClick={() => onPickMilestone(milestone)}>
                      Usar hito
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
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

/** Shaped skeleton of the five blocks, so the layout never jumps. */
function BoardSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-5">
      <Skeleton className="ob-shimmer h-3 w-48" />
      <Skeleton className="ob-shimmer h-24 w-full rounded-md" />
      <div className="grid gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="ob-shimmer h-16 w-full rounded-md" delay={index * 90} />
        ))}
      </div>
      <Skeleton className="ob-shimmer h-20 w-full rounded-md" delay={120} />
    </div>
  );
}
