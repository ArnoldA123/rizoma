'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BOARD_POLL_DEFAULT_MS,
  BOARD_POLL_MAX_MS,
  BOARD_POLL_MIN_MS,
  clampBoardPollMs,
  type DashboardRole,
  type SaludDashboardBoard,
} from '@rizoma/contracts';
import { Button } from '@/components/ui/button';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FailurePanel } from '@/components/salud/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { DEV_IDENTITY } from '@/lib/config';
import { listOrgNodes } from '@/lib/org-api';
import { formatPen } from '@/lib/format';
import { boardRoleLabel } from '@/lib/labels';
import { getSaludBoard } from '@/lib/salud-api';
import {
  boardCacheKey,
  downloadSaludBoardCsv,
  fetchComparedSaludBoard,
  readBoardCache,
  writeBoardCache,
  type BoardCompareMode,
  type ComparedSaludBoard,
} from '@/lib/salud-board-cache';
import { saveTextFile } from '@/lib/salud-download';
import {
  currentSedeDate,
  formatElapsed,
  formatUtcDateLong,
  isCurrentSedeDate,
  resolveSedeTimezone,
  shiftUtcDate,
} from '@/lib/salud-time';
import type { OrgNodeRecord } from '@rizoma/contracts';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * `/salud/tableros/[role]` — one role board, read straight from the API.
 *
 * The board is the place where the two negative properties of §6.3 become
 * visible: the caja board carries amounts and fiscal states and *no* clinical
 * field, and the médico board carries counts and *no* amount. Those are contract
 * properties, tested in `@rizoma/contracts`, and this screen simply renders what
 * the schema accepted.
 *
 * The read path is where the UI earns its keep:
 *
 *   - **Polling inside the band.** `BOARD_POLL_*` fixes 1–5 minutes; the default
 *     is three. The timer pauses while the tab is hidden and refreshes once on
 *     return, so a background tab never keeps a primary connection busy;
 *   - **Silent refresh.** A poll replaces the numbers in place — no skeleton
 *     flash every three minutes — and a failure keeps the last good board on
 *     screen while it names the envelope;
 *   - **Client cache.** `lib/salud-board-cache.ts` serves the last board of the
 *     same `role|sede|día` for a minute, so moving the day or the sede does not
 *     blank the screen. The consolidated bases put this on a read replica with a
 *     5–15 minute cache; MVP1 has neither, and this is the honest substitute.
 */
export interface RoleBoardProps {
  readonly role: DashboardRole;
  readonly className?: string;
}

export function RoleBoard({ role, className }: RoleBoardProps) {
  const [orgNodeId, setOrgNodeId] = useState(DEV_IDENTITY.orgNodeId);
  const [date, setDate] = useState(() => currentSedeDate());
  const [pollMs, setPollMs] = useState(BOARD_POLL_DEFAULT_MS);
  const [compare, setCompare] = useState<BoardCompareMode>('off');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<ApiFailure | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sedeItems, setSedeItems] = useState<readonly EntityItem[]>([]);
  const [sedeNodes, setSedeNodes] = useState<readonly OrgNodeRecord[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listOrgNodes({ kind: 'sede' }, controller.signal)
      .then((rows) => {
        if (!active) return;
        setSedeItems(rows.map((row) => ({ id: row.id, label: row.name })));
        setSedeNodes(rows);
      })
      .catch(() => {
        if (active) {
          setSedeItems([]);
          setSedeNodes([]);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const org = orgNodeId.trim();
  // The sede travels as a parameter: the selected sede's zone from the org
  // tree, Lima fallback while the list loads or when the row has no zone.
  const sedeTimezone = resolveSedeTimezone(sedeNodes, org === '' ? null : org);
  const cacheKey = boardCacheKey(role, org, date);
  const board = useResource<SaludDashboardBoard>(
    cacheKey,
    (signal) => getSaludBoard(role, { date, ...(org === '' ? {} : { org }) }, signal),
    // A board read through an empty `org` resolves to the membership node, which
    // the client cannot predict, so the cache is only consulted for an explicit
    // sede.
    { initialData: org === '' ? null : readBoardCache(role, org, date) },
  );

  const reloadSilently = board.reloadSilently;
  const data = board.data;

  // Day-vs-−7d comparison (`GET ...?compare=previous-week`). The hook always
  // runs, so `off` resolves to `null` without a request; any other mode
  // reads fresh, outside the one-minute board cache.
  const compareKey = `compare|${cacheKey}|${compare}`;
  const compared = useResource<ComparedSaludBoard | null>(compareKey, (signal) =>
    compare === 'off'
      ? Promise.resolve(null)
      : fetchComparedSaludBoard(role, { date, ...(org === '' ? {} : { org }) }, signal),
  );
  const delta = compared.data?.delta ?? null;
  const previousDate = compared.data?.previous.date ?? null;

  // A board is only rendered when it belongs to the key on screen: either the
  // answer for that key, or a cached board the hook seeded for it. Otherwise the
  // shaped skeleton shows, so yesterday's numbers never sit under today's
  // heading.
  const dataIsCurrent =
    data !== null && boardCacheKey(data.role, data.orgNodeId, data.date) === cacheKey;
  const visibleBoard = data !== null && (dataIsCurrent || !board.loading) ? data : null;

  // The board the API echoed back is what the cache stores, so the key always
  // describes the board it holds.
  useEffect(() => {
    if (data !== null) writeBoardCache(data);
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

  const setPollPeriod = useCallback((value: number) => setPollMs(clampBoardPollMs(value)), []);

  const downloadCsv = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const file = await downloadSaludBoardCsv(role, { date, ...(org === '' ? {} : { org }) });
      saveTextFile(file.filename, file.csv);
    } catch (error) {
      setDownloadError(classifyApiError(error));
    } finally {
      setDownloading(false);
    }
  }, [role, org, date]);

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <Card>
        <CardHeader>
          <CardEyebrow>Tablero · {boardRoleLabel(role)}</CardEyebrow>
          <CardTitle as="h2" className="text-lg">
            {formatUtcDateLong(date)}
          </CardTitle>
          <CardDescription>
            El API exige que el rol de quien consulta sea el mismo del tablero; la sede debe estar
            dentro de su subárbol. El día es el de la sede, igual que el filtro de la agenda y de la caja.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDate(shiftUtcDate(date, -1))}>
              Día anterior
            </Button>
            <Button
              variant={isCurrentSedeDate(date, sedeTimezone) ? 'ghost' : 'outline'}
              size="sm"
              disabled={isCurrentSedeDate(date, sedeTimezone)}
              onClick={() => setDate(currentSedeDate(sedeTimezone))}
            >
              Hoy
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDate(shiftUtcDate(date, 1))}>
              Día siguiente
            </Button>

            <label htmlFor="board-date" className="sr-only">
              Día del tablero
            </label>
            <Input
              id="board-date"
              type="date"
              className="w-40"
              value={date}
              onChange={(event) => {
                if (event.target.value !== '') setDate(event.target.value);
              }}
            />

            <div className="w-64">
              <EntitySelector
                label="Sede"
                items={sedeItems}
                value={org.trim() === '' ? null : org}
                onChange={(id) => setOrgNodeId(id ?? '')}
                placeholder="Nodo de la membresía"
                searchPlaceholder="Buscar por nombre…"
              />
            </div>
          </div>

          {/* The cadence in force is exposed as a pressed state, so a screen
              reader hears the selection instead of relying on the variant. */}
          <div
            role="group"
            aria-label="Lectura automática"
            className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
          >
            <span className="text-xs text-muted-foreground">Lectura automática:</span>
            {[
              { label: '1 min', value: BOARD_POLL_MIN_MS },
              { label: '3 min', value: BOARD_POLL_DEFAULT_MS },
              { label: '5 min', value: BOARD_POLL_MAX_MS },
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
              (day vs −7d) and the CSV carries the same aggregate as the JSON
              board. The active mode is exposed as a pressed state. */}
          <div
            role="group"
            aria-label="Comparativa y descarga"
            className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
          >
            <span className="text-xs text-muted-foreground">Comparativa:</span>
            {[
              { label: 'Sin comparativa', value: 'off' as BoardCompareMode },
              { label: 'Semana anterior (−7 d)', value: 'previous-week' as BoardCompareMode },
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
        </CardContent>
      </Card>

      {board.failure !== null ? (
        <FailurePanel
          title={`No se pudo leer el tablero de ${boardRoleLabel(role)}`}
          failure={board.failure}
          onRetry={board.reload}
        />
      ) : null}

      {board.loading && visibleBoard === null ? <BoardSkeleton /> : null}

      {visibleBoard === null ? null : (
        <BoardKpis board={visibleBoard} delta={delta} previousDate={previousDate} />
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

/** KPI grid of the board, switched by role — the discriminated union of §6.3. */
function BoardKpis({
  board,
  delta,
  previousDate,
}: {
  readonly board: SaludDashboardBoard;
  readonly delta: Readonly<Record<string, number>> | null;
  readonly previousDate: string | null;
}) {
  if (board.role === 'caja') {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Kpi label="Cobrado hoy" value={formatPen(board.todayCollected)} hint="Cobros registrados del día" delta={deltaText(delta, 'todayCollected', previousDate)} />
          <Kpi label="Comprobantes emitidos" value={String(board.invoicesIssued)} hint="Del día en la sede" delta={deltaText(delta, 'invoicesIssued', previousDate)} />
          <Kpi label="Pendientes fiscales" value={String(board.fiscalPending)} hint="Emitidos sin aceptar" delta={deltaText(delta, 'fiscalPending', previousDate)} />
        </div>
        <Card tone="tinted">
          <CardHeader>
            <CardEyebrow>Arqueo</CardEyebrow>
            <CardTitle as="h3">
              {board.openSession === null ? 'Sin turno abierto' : 'Turno abierto'}
            </CardTitle>
            <CardDescription>
              {board.openSession === null
                ? 'El API no encontró un turno abierto en la sede: emitir un comprobante respondería billing.cash_session_closed.'
                : 'Use este identificador para cerrar el turno desde la pantalla de caja.'}
            </CardDescription>
          </CardHeader>
          {board.openSession === null ? null : (
            <CardContent>
              <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">turno</dt>
                <dd className="font-mono break-all">{board.openSession.id}</dd>
                <dt className="text-muted-foreground">sede</dt>
                <dd className="font-mono break-all">{board.openSession.orgNodeId}</dd>
                <dt className="text-muted-foreground">apertura</dt>
                <dd>{board.openSession.openedAt ?? '—'}</dd>
              </dl>
            </CardContent>
          )}
        </Card>
        <p className="text-xs text-muted-foreground">
          Este contrato no declara ningún campo clínico: ni nombres de paciente ni diagnósticos. El
          tablero de caja transporta importes y estados fiscales únicamente.
        </p>
      </div>
    );
  }

  if (board.role === 'medico') {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Kpi label="Mis citas de hoy" value={String(board.myAppointments)} hint="Solo las propias" delta={deltaText(delta, 'myAppointments', previousDate)} />
          <Kpi label="Episodios abiertos" value={String(board.openEpisodes)} hint="A mi nombre" delta={deltaText(delta, 'openEpisodes', previousDate)} />
          <Kpi label="Consentimientos pendientes" value={String(board.pendingConsents)} hint="Por firmar" delta={deltaText(delta, 'pendingConsents', previousDate)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Este contrato declara conteos y ningún importe: el tablero clínico no transporta cobros.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <Kpi label="Citas de hoy" value={String(board.todayAppointments)} hint="En la sede" delta={deltaText(delta, 'todayAppointments', previousDate)} />
        <Kpi label="Espera promedio" value={`${board.waitingAvgMin} min`} hint="Con un decimal" delta={deltaText(delta, 'waitingAvgMin', previousDate)} />
        <Kpi label="Inasistencias" value={String(board.noShows)} hint="No asistió" delta={deltaText(delta, 'noShows', previousDate)} />
        <Kpi label="Cola" value={String(board.queue)} hint="En espera" delta={deltaText(delta, 'queue', previousDate)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Conteos de recepción: ni importes ni contenido clínico. La cola cuenta las citas en
        espera y en atención; las derivadas salieron de la agenda y no entran en estos
        conteos. El tablero de caja y el clínico son contratos separados por diseño, no dos
        vistas del mismo objeto.
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  delta,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly delta?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardEyebrow>{label}</CardEyebrow>
        <CardTitle as="h3" className="tabular text-2xl">
          {value}
        </CardTitle>
        <CardDescription>{hint}</CardDescription>
        {delta === undefined ? null : (
          <p className="tabular text-xs text-muted-foreground">{delta}</p>
        )}
      </CardHeader>
    </Card>
  );
}

/** Loading shape of the KPI grid: same geometry, so nothing jumps. */
function BoardSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-2.5 w-24" delay={index * 90} />
            <Skeleton className="h-7 w-20" delay={index * 90 + 60} />
            <Skeleton className="h-2.5 w-32" delay={index * 90 + 120} />
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
