'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { SkeletonRows } from '@/components/ui/skeleton';
import { IconArrowRight } from '@/components/ui/icons';
import { FailurePanel } from '@/components/salud/states';
import { formatPen, formatSedeStamp } from '@/lib/format';
import { getSaludBoard } from '@/lib/salud-api';
import { listOrgNodes } from '@/lib/org-api';
import type { OrgNodeRecord } from '@rizoma/contracts';
import { useEffect, useState } from 'react';
import { currentSedeDate, formatUtcDateLong, resolveSedeTimezone } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import type { HomeLink } from './role-home';

export interface CajaDayProps {
  readonly links: readonly HomeLink[];
}

/**
 * Day cover of the caja role (P3-1a).
 *
 * Everything comes from the caja board: the open shift (opening date plus
 * state, never the session id), the amount collected today, the invoices
 * issued and the fiscal pending count. The contract carries no clinical
 * field, so this cover names none.
 */
export function CajaDay({ links }: CajaDayProps) {
  const board = useResource('home-board:caja', (signal) => getSaludBoard('caja', {}, signal));
  // The sede travels as a parameter: zone of the board's sede from the org
  // tree, Lima fallback while the list loads or when the row has no zone.
  const [sedeNodes, setSedeNodes] = useState<readonly OrgNodeRecord[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listOrgNodes({ kind: 'sede' }, controller.signal)
      .then((nodes) => {
        if (active) setSedeNodes(nodes);
      })
      .catch(() => {
        if (active) setSedeNodes([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const boardOrg = board.data !== null && board.data.role === 'caja' ? board.data.orgNodeId : null;
  const sedeTimezone = resolveSedeTimezone(sedeNodes, boardOrg);
  const today = currentSedeDate(sedeTimezone);

  const cajaBoard = board.data !== null && board.data.role === 'caja' ? board.data : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Caja · hoy"
        title="Su turno de hoy"
        description={`${formatUtcDateLong(today)}: turno abierto, cobrado del día, comprobantes emitidos y pendientes fiscales.`}
        action={
          <Link href="/salud/tableros/caja" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Abrir mi tablero
          </Link>
        }
      />

      {board.failure !== null ? (
        <FailurePanel title="No se pudo leer su día" failure={board.failure} onRetry={board.reload} />
      ) : null}

      {board.loading && cajaBoard === null ? (
        <SkeletonRows rows={3} />
      ) : cajaBoard === null ? null : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <DayCount label="Cobrado hoy" value={formatPen(cajaBoard.todayCollected)} hint="Cobros registrados del día" />
            <DayCount label="Comprobantes emitidos" value={String(cajaBoard.invoicesIssued)} hint="Del día en la sede" />
            <DayCount label="Pendientes fiscales" value={String(cajaBoard.fiscalPending)} hint="Emitidos sin aceptar" />
          </div>
          <Card tone="tinted">
            <CardHeader>
              <CardEyebrow>Turno</CardEyebrow>
              <CardTitle as="h3">
                {cajaBoard.openSession === null ? 'Sin turno abierto' : 'Turno abierto'}
              </CardTitle>
              <CardDescription>
                {cajaBoard.openSession === null
                  ? 'No hay un turno abierto en la sede: emitir un comprobante responderá con turno cerrado.'
                  : `Abierto el ${formatSedeStamp(cajaBoard.openSession.openedAt, sedeTimezone)} · estado abierto. El turno se gestiona desde la pantalla de caja.`}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )}

      <EnabledScreens links={links} />
    </div>
  );
}

/** One day count: label, big number and a one-line hint. */
function DayCount({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint: string }) {
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

/**
 * Link list to the enabled screens of the role. Local copy of the shell list
 * so this cover stays self-contained inside its own file.
 */
function EnabledScreens({ links }: { readonly links: readonly HomeLink[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Pantallas habilitadas para su rol</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {links.length === 0 ? (
          <p className="text-muted-foreground">
            Su rol no habilita ninguna pantalla del alcance actual. Si necesita acceso, avise a
            jefatura o a soporte.
          </p>
        ) : (
          links.map((link) => (
            <Link
              key={link.path}
              href={link.path}
              className="group flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3 transition-colors hover:bg-secondary"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-accent-tint text-accent"
                >
                  <RouteIcon path={link.path} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.description}</span>
                </span>
              </span>
              <IconArrowRight className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
