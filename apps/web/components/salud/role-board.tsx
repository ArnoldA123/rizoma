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
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FailurePanel } from '@/components/salud/states';
import { DEV_IDENTITY } from '@/lib/config';
import { formatPen } from '@/lib/format';
import { boardRoleLabel } from '@/lib/labels';
import { getSaludBoard } from '@/lib/salud-api';
import { boardCacheKey, readBoardCache, writeBoardCache } from '@/lib/salud-board-cache';
import {
  currentUtcDate,
  formatElapsed,
  formatUtcDateLong,
  isCurrentUtcDate,
  shiftUtcDate,
} from '@/lib/salud-time';
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
  const [date, setDate] = useState(() => currentUtcDate());
  const [pollMs, setPollMs] = useState(BOARD_POLL_DEFAULT_MS);
  const [now, setNow] = useState(() => Date.now());

  const org = orgNodeId.trim();
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
            dentro de su subárbol. El día es UTC, igual que el filtro de la agenda y de la caja.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setDate(shiftUtcDate(date, -1))}>
              Día anterior
            </Button>
            <Button
              variant={isCurrentUtcDate(date) ? 'ghost' : 'outline'}
              size="sm"
              disabled={isCurrentUtcDate(date)}
              onClick={() => setDate(currentUtcDate())}
            >
              Hoy (UTC)
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

            <label htmlFor="board-org" className="sr-only">
              Sede del tablero
            </label>
            <Input
              id="board-org"
              className="w-64 font-mono text-xs"
              spellCheck={false}
              placeholder="Sede (UUID); vacío: nodo de la membresía"
              value={orgNodeId}
              onChange={(event) => setOrgNodeId(event.target.value)}
            />
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

      {visibleBoard === null ? null : <BoardKpis board={visibleBoard} />}
    </div>
  );
}

/** KPI grid of the board, switched by role — the discriminated union of §6.3. */
function BoardKpis({ board }: { readonly board: SaludDashboardBoard }) {
  if (board.role === 'caja') {
    return (
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Kpi label="Cobrado hoy" value={formatPen(board.todayCollected)} hint="Cobros registrados del día" />
          <Kpi label="Comprobantes emitidos" value={String(board.invoicesIssued)} hint="Del día en la sede" />
          <Kpi label="Pendientes fiscales" value={String(board.fiscalPending)} hint="Emitidos sin aceptar" />
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
          <Kpi label="Mis citas de hoy" value={String(board.myAppointments)} hint="Solo las propias" />
          <Kpi label="Episodios abiertos" value={String(board.openEpisodes)} hint="A mi nombre" />
          <Kpi label="Consentimientos pendientes" value={String(board.pendingConsents)} hint="Por firmar" />
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
        <Kpi label="Citas de hoy" value={String(board.todayAppointments)} hint="En la sede" />
        <Kpi label="Espera promedio" value={`${board.waitingAvgMin} min`} hint="Con un decimal" />
        <Kpi label="Inasistencias" value={String(board.noShows)} hint="No asistió" />
        <Kpi label="Cola" value={String(board.queue)} hint="En espera" />
      </div>
      <p className="text-xs text-muted-foreground">
        Conteos de recepción: ni importes ni contenido clínico. El tablero de caja y el clínico son
        contratos separados por diseño, no dos vistas del mismo objeto.
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardEyebrow>{label}</CardEyebrow>
        <CardTitle as="h3" className="tabular text-2xl">
          {value}
        </CardTitle>
        <CardDescription>{hint}</CardDescription>
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
