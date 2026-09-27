'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  invoiceListSchema,
  type CompanyBoard,
  type InvoiceRecord,
  type OrgNodeRecord,
  type SiteLogRecord,
  type SiteRecord,
  type StockMoveRecord,
} from '@rizoma/contracts';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { SkeletonRows } from '@/components/ui/skeleton';
import { IconArrowRight } from '@/components/ui/icons';
import { EmptyState, FailurePanel } from '@/components/ui/states';
import { requestJson } from '@/lib/api-client';
import { formatPen, formatQuantity, formatSedeStamp } from '@/lib/format';
import { getCompanyBoard, listInventoryItems, listSiteLogs, listSites, listStockMoves } from '@/lib/obras-api';
import { listUsers } from '@/lib/users-api';
import { listOrgNodes } from '@/lib/org-api';
import { currentSedeDate, formatUtcDateLong, resolveSedeTimezone } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import type { HomeLink } from './role-home';

export interface AuditorDayProps {
  readonly links: readonly HomeLink[];
}

/** How many recent rows each movement list shows. */
const RECENT_LIMIT = 8;
/** How many obras the bitácora read fans out to — the endpoint is per obra. */
const LOG_SITES_LIMIT = 3;

/**
 * Day cover of the auditor role (P3-1b).
 *
 * The company board aggregates the whole membership scope (obras plus avance);
 * the movements below are the last rows of the existing reads — bitácora of the
 * first obras, stock moves of the scope and issued invoices — with names
 * resolved against the scope lists. No endpoint is added: every read already
 * exists. Names own every row — no identifier is rendered.
 */
export function AuditorDay({ links }: AuditorDayProps) {
  const board = useResource<CompanyBoard>('home-board:auditor', (signal) =>
    getCompanyBoard(signal),
  );
  // The sede travels as a parameter: first sede zone from the org tree, Lima
  // fallback while the list loads or when the row has no zone.
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

  const sedeTimezone = resolveSedeTimezone(sedeNodes);
  const today = currentSedeDate(sedeTimezone);
  const sites = useResource<SiteRecord[]>('home-sites:auditor', (signal) =>
    listSites(signal),
  );
  const moves = useResource<StockMoveRecord[]>('home-moves:auditor', (signal) =>
    listStockMoves(signal),
  );
  const invoices = useResource<readonly InvoiceRecord[]>(
    'home-invoices:auditor',
    (signal) => readInvoices(signal),
  );

  const siteRows = sites.data ?? [];
  const siteNames = new Map(siteRows.map((row) => [row.id, `${row.code} · ${row.name}`]));

  const logs = useResource<readonly SiteLogRecord[]>(
    `home-logs:auditor:${siteRows
      .slice(0, LOG_SITES_LIMIT)
      .map((row) => row.id)
      .join(',')}`,
    (signal) => readRecentLogs(siteRows.slice(0, LOG_SITES_LIMIT).map((row) => row.id), signal),
  );

  const [itemNames, setItemNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [userNames, setUserNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const signal = controller.signal;
    Promise.allSettled([listInventoryItems(signal), listUsers({}, signal)]).then(
      ([items, users]) => {
        if (!active) return;
        if (items.status === 'fulfilled') {
          setItemNames(new Map(items.value.map((row) => [row.id, row.name])));
        }
        if (users.status === 'fulfilled') {
          setUserNames(new Map(users.value.map((row) => [row.id, row.name])));
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const companyBoard = board.data ?? null;
  const recentMoves = (moves.data ?? []).slice().sort(compareByAt).slice(0, RECENT_LIMIT);
  const recentInvoices = (invoices.data ?? [])
    .slice()
    .sort(compareInvoicesByIssued)
    .slice(0, RECENT_LIMIT);
  const recentLogs = (logs.data ?? []).slice().sort(compareByAt).slice(0, RECENT_LIMIT);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Auditoría · hoy"
        title="Tablero de la empresa"
        description={`${formatUtcDateLong(today)}: obras y avance agregado del alcance, más los movimientos recientes con nombre y fecha.`}
        action={
          <Link href="/obras/tablero" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Abrir tablero de obras
          </Link>
        }
      />

      {board.failure !== null ? (
        <FailurePanel
          title="No se pudo leer el tablero de empresa"
          failure={board.failure}
          onRetry={board.reload}
        />
      ) : null}

      {board.loading && companyBoard === null ? <SkeletonRows rows={2} /> : null}

      {companyBoard === null ? null : (
        <div className="grid gap-4 sm:grid-cols-4">
          <DayCount label="Obras en el alcance" value={String(companyBoard.sites.total)} hint="Total" />
          <DayCount label="En ejecución" value={String(companyBoard.sites.active)} hint="Activas" />
          <DayCount
            label="Cantidad ejecutada"
            value={formatQuantity(companyBoard.progress.qtyDone)}
            hint={`de ${formatQuantity(companyBoard.progress.qtyPlanned)} prevista`}
          />
          <DayCount
            label="Avance agregado"
            value={`${companyBoard.progress.percent} %`}
            hint="Del alcance"
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardEyebrow>Bitácora</CardEyebrow>
            <CardTitle as="h2">Movimientos de obra</CardTitle>
            <CardDescription>Últimas notas de bitácora, con obra y autor.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {logs.loading && recentLogs.length === 0 ? <SkeletonRows rows={3} /> : null}
            {!logs.loading && logs.failure !== null ? (
              <FailurePanel
                title="No se pudo leer la bitácora"
                failure={logs.failure}
                onRetry={logs.reload}
              />
            ) : null}
            {!logs.loading && logs.failure === null && recentLogs.length === 0 ? (
              <EmptyState
                eyebrow="Sin notas"
                title="Sin movimientos de bitácora"
                description="El API respondió con listas válidas y vacías en las obras del alcance."
              />
            ) : null}
            {recentLogs.length === 0 ? null : (
              <ul className="flex flex-col">
                {recentLogs.map((log) => (
                  <li
                    key={log.id}
                    className="flex min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
                  >
                    <span className="truncate text-[0.8125rem]">{log.text}</span>
                    <span className="text-xs text-muted-foreground">
                      {siteNames.get(log.siteId) ?? 'Obra del alcance'} ·{' '}
                      {userNames.get(log.authorId) ?? 'Autor del alcance'} ·{' '}
                      {formatSedeStamp(log.at, sedeTimezone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardEyebrow>Almacén</CardEyebrow>
            <CardTitle as="h2">Movimientos de stock</CardTitle>
            <CardDescription>Últimos movimientos, con ítem y fecha.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {moves.loading && recentMoves.length === 0 ? <SkeletonRows rows={3} /> : null}
            {!moves.loading && moves.failure !== null ? (
              <FailurePanel
                title="No se pudo leer el stock"
                failure={moves.failure}
                onRetry={moves.reload}
              />
            ) : null}
            {!moves.loading && moves.failure === null && recentMoves.length === 0 ? (
              <EmptyState
                eyebrow="Sin movimientos"
                title="Sin movimientos de stock"
                description="El API respondió con una lista válida y vacía en el alcance actual."
              />
            ) : null}
            {recentMoves.length === 0 ? null : (
              <ul className="flex flex-col">
                {recentMoves.map((move) => (
                  <li
                    key={move.id}
                    className="flex min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
                  >
                    <span className="text-[0.8125rem]">
                      {itemNames.get(move.itemId) ?? 'Ítem del alcance'} · {move.kind} ·{' '}
                      {formatQuantity(move.qty)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatSedeStamp(move.at, sedeTimezone)} · {move.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardEyebrow>Facturación</CardEyebrow>
            <CardTitle as="h2">Comprobantes recientes</CardTitle>
            <CardDescription>Últimos comprobantes, con cliente y total.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {invoices.loading && recentInvoices.length === 0 ? <SkeletonRows rows={3} /> : null}
            {!invoices.loading && invoices.failure !== null ? (
              <FailurePanel
                title="No se pudieron leer los comprobantes"
                failure={invoices.failure}
                onRetry={invoices.reload}
              />
            ) : null}
            {!invoices.loading && invoices.failure === null && recentInvoices.length === 0 ? (
              <EmptyState
                eyebrow="Sin comprobantes"
                title="Sin comprobantes recientes"
                description="El API respondió con una lista válida y vacía en el alcance actual."
              />
            ) : null}
            {recentInvoices.length === 0 ? null : (
              <ul className="flex flex-col">
                {recentInvoices.map((invoice) => (
                  <li
                    key={invoice.id}
                    className="flex min-w-0 flex-col gap-0.5 border-b border-border py-2 last:border-b-0"
                  >
                    <span className="text-[0.8125rem]">
                      {invoice.customerName} · {formatPen(invoice.total)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {invoice.serie}-{invoice.numero} · {invoice.status} ·{' '}
                      {formatSedeStamp(invoice.issuedAt, sedeTimezone)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <EnabledScreens links={links} />
    </div>
  );
}

/** Reads the existing invoice list (same endpoint the caja board reads). */
async function readInvoices(signal: AbortSignal): Promise<readonly InvoiceRecord[]> {
  const rows = await requestJson('/billing/invoices', invoiceListSchema, { signal });
  return rows ?? [];
}

/** Reads the bitácora of the given obras and merges them newest-first. */
async function readRecentLogs(
  siteIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly SiteLogRecord[]> {
  if (siteIds.length === 0) return [];
  const settled = await Promise.allSettled(
    siteIds.map((siteId) => listSiteLogs(siteId, signal)),
  );
  const merged: SiteLogRecord[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') merged.push(...result.value);
  }
  return merged;
}

/** Newest `at` first; a missing or unreadable date sorts last. */
function compareByAt(
  left: { readonly at: string | null | undefined },
  right: { readonly at: string | null | undefined },
): number {
  const leftTime = Date.parse(left.at ?? '');
  const rightTime = Date.parse(right.at ?? '');
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
  if (Number.isNaN(leftTime)) return 1;
  if (Number.isNaN(rightTime)) return -1;
  return rightTime - leftTime;
}

/** Newest `issuedAt` first; an unreadable date sorts last. */
function compareInvoicesByIssued(left: InvoiceRecord, right: InvoiceRecord): number {
  return compareByAt({ at: left.issuedAt ?? '' }, { at: right.issuedAt ?? '' });
}

/** One day count: label, big value and a one-line hint. */
function DayCount({
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
