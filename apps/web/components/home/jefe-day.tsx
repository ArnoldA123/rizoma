'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { OrgNodeRecord, SiteBoard, SiteRecord } from '@rizoma/contracts';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { EntitySelector } from '@/components/ui/entity-select';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { SkeletonRows } from '@/components/ui/skeleton';
import { IconArrowRight } from '@/components/ui/icons';
import { EmptyState, FailurePanel } from '@/components/ui/states';
import { formatQuantity } from '@/lib/format';
import { siteStatusLabel } from '@/lib/labels';
import { getSiteBoard, listSites } from '@/lib/obras-api';
import { listOrgNodes } from '@/lib/org-api';
import { currentSedeDate, formatUtcDateLong, resolveSedeTimezone } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import type { HomeLink } from './role-home';

export interface JefeDayProps {
  readonly links: readonly HomeLink[];
}

/**
 * Day cover of the obra roles (P3-1b): jefe_obra, capataz, gerente, almacén.
 *
 * The cover reads the obra list of the membership scope and focuses the first
 * obra by default; when the scope holds more than one, an EntitySelector of
 * sedes/obras picks the one on screen. The summary below is the site board of
 * today in the sede zone (avance, asistencia, stock crítico, hitos). Names own
 * every row — no identifier is rendered.
 */
export function JefeDay({ links }: JefeDayProps) {
  const sites = useResource<SiteRecord[]>('home-sites:obra', (signal) => listSites(signal));
  const rows = sites.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const activeId = selectedId ?? rows[0]?.id ?? null;
  const active = rows.find((row) => row.id === activeId) ?? rows[0] ?? null;

  const board = useResource<SiteBoard | null>(
    `home-site-board:${activeId ?? 'none'}:${today}`,
    (signal) =>
      activeId === null ? Promise.resolve(null) : getSiteBoard(activeId, { date: today }, signal),
  );
  const siteBoard = board.data ?? null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Obra · hoy"
        title={active === null ? 'Su obra de hoy' : active.name}
        description={
          active === null
            ? `${formatUtcDateLong(today)}: avance, asistencia, stock crítico e hitos de su obra.`
            : `${formatUtcDateLong(today)}: avance, asistencia, stock crítico e hitos de ${active.code} · ${active.clientName}.`
        }
        action={
          activeId === null ? undefined : (
            <span className="flex flex-wrap gap-2">
              <Link
                href={`/obras/${encodeURIComponent(activeId)}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Abrir mi obra
              </Link>
              <Link href="/obras/tablero" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                Tablero de obras
              </Link>
            </span>
          )
        }
      />

      {sites.failure !== null ? (
        <FailurePanel
          title="No se pudieron leer sus obras"
          failure={sites.failure}
          onRetry={sites.reload}
        />
      ) : null}

      {sites.loading && rows.length === 0 ? <SkeletonRows rows={2} /> : null}

      {!sites.loading && sites.failure === null && rows.length === 0 ? (
        <EmptyState
          eyebrow="Sin obras"
          title="Sin obras en su alcance"
          description="El API respondió con una lista válida y vacía: su membresía no alcanza ninguna obra hoy. Si espera ver una, avise a jefatura o a soporte."
        />
      ) : null}

      {rows.length > 1 ? (
        <Card>
          <CardContent className="pt-6">
            <EntitySelector
              label="Obra"
              items={rows.map((row) => ({
                id: row.id,
                label: `${row.code} · ${row.name}`,
                sub: `${row.clientName} · ${siteStatusLabel(row.status)}`,
              }))}
              value={activeId}
              onChange={setSelectedId}
              placeholder="Seleccionar obra…"
              searchPlaceholder="Buscar obra…"
            />
          </CardContent>
        </Card>
      ) : null}

      {activeId === null || active === null ? null : (
        <>
          {board.failure !== null ? (
            <FailurePanel
              title="No se pudo leer el día de su obra"
              failure={board.failure}
              onRetry={board.reload}
            />
          ) : null}

          {board.loading && siteBoard === null ? <SkeletonRows rows={4} /> : null}

          {siteBoard === null ? null : (
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-4">
                <DayCount
                  label="Líneas con avance"
                  value={String(siteBoard.progress.length)}
                  hint="Líneas de presupuesto"
                />
                <DayCount
                  label="Asistencia registrada"
                  value={`${siteBoard.attendance.registered} de ${siteBoard.attendance.total}`}
                  hint="Marcas del día"
                />
                <DayCount
                  label="Stock crítico"
                  value={String(siteBoard.criticalStock.length)}
                  hint="Ítems bajo el mínimo"
                />
                <DayCount
                  label="Hitos próximos"
                  value={String(siteBoard.upcomingMilestones.length)}
                  hint="Pendientes en horizonte"
                />
              </div>

              <Card>
                <CardHeader>
                  <CardEyebrow>Avance</CardEyebrow>
                  <CardTitle as="h2">Avance por línea</CardTitle>
                  <CardDescription>
                    Ejecutado contra lo previsto por línea de presupuesto. El detalle por partida
                    vive en la ficha de la obra.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {siteBoard.progress.length === 0 ? (
                    <p className="text-muted-foreground">
                      Sin líneas de presupuesto registradas para esta obra.
                    </p>
                  ) : (
                    <ul className="flex flex-col">
                      {siteBoard.progress.slice(0, 5).map((line) => (
                        <li
                          key={line.budgetLineId}
                          className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                        >
                          <span className="text-[0.8125rem]">{line.description}</span>
                          <span className="tabular text-xs text-muted-foreground">
                            {formatQuantity(line.qtyDone)} de {formatQuantity(line.qtyPlanned)} ·{' '}
                            {line.percent} %
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardEyebrow>Stock crítico</CardEyebrow>
                    <CardTitle as="h2">Ítems bajo el mínimo</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {siteBoard.criticalStock.length === 0 ? (
                      <p className="text-muted-foreground">
                        Ningún ítem por debajo de su mínimo en el alcance de la obra.
                      </p>
                    ) : (
                      <ul className="flex flex-col">
                        {siteBoard.criticalStock.slice(0, 5).map((item) => (
                          <li
                            key={item.itemId}
                            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                          >
                            <span className="text-[0.8125rem]">{item.name}</span>
                            <span className="tabular text-xs text-muted-foreground">
                              disponible {formatQuantity(item.available)} {item.unit} · mínimo{' '}
                              {formatQuantity(item.minStock)} {item.unit}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardEyebrow>Hitos</CardEyebrow>
                    <CardTitle as="h2">Hitos próximos</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {siteBoard.upcomingMilestones.length === 0 ? (
                      <p className="text-muted-foreground">
                        Sin hitos pendientes dentro del horizonte del tablero.
                      </p>
                    ) : (
                      <ul className="flex flex-col">
                        {siteBoard.upcomingMilestones.slice(0, 5).map((milestone) => (
                          <li
                            key={milestone.milestoneId}
                            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                          >
                            <span className="text-[0.8125rem]">{milestone.name}</span>
                            <span className="tabular text-xs text-muted-foreground">
                              {milestone.dueAt === null ? 'sin fecha' : milestone.dueAt.slice(0, 10)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </>
      )}

      <EnabledScreens links={links} />
    </div>
  );
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
