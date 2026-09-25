'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SiteRecord } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel } from '@/components/ui/states';
import { SiteForm } from '@/components/obras/site-form';
import { formatPen } from '@/lib/format';
import { siteStatusLabel, siteStatusVariant, roleLabel } from '@/lib/labels';
import { listSites } from '@/lib/obras-api';
import { PAGE_SIZE, paginate } from '@/lib/salud-select';
import { formatUtcDate } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * `/obras` — the site list and the registration form.
 *
 * The read path is the same honest one as `/salud/pacientes`: the API caps every
 * list at 200 rows and offers no cursor and no search, so the text filter and
 * the paginator run **in the browser** over the loaded page and say so.
 *
 * What is specific to this vertical is *which* sites come back: the service
 * scopes the query to the membership subtree, so `jefe_obra` sees its obras and
 * a worker sees none until assigned. This screen never widens that: it renders
 * exactly the rows the API returned.
 */
export interface SitesBrowserProps {
  /** Role driving the capability gates. */
  readonly role: string | null;
  /** `site.write` — the role may register a new obra. */
  readonly canWrite: boolean;
  /** Sede the registration form prefills; refined from the first row read. */
  readonly defaultOrgNodeId: string;
}

export function SitesBrowser({ role, canWrite, defaultOrgNodeId }: SitesBrowserProps) {
  const sites = useResource<SiteRecord[]>('obras-sites', (signal) => listSites(signal));
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [lastCreated, setLastCreated] = useState<SiteRecord | null>(null);

  const rows = sites.data ?? [];
  // The first real row is a better sede hint than the dev fallback, exactly like
  // the patient browser does for its registration form.
  const knownOrgNodeId = rows[0]?.orgNodeId ?? defaultOrgNodeId;
  const needle = filter.trim().toLowerCase();
  const filtered =
    needle === ''
      ? rows
      : rows.filter(
          (row) =>
            row.code.toLowerCase().includes(needle) ||
            row.name.toLowerCase().includes(needle) ||
            row.clientName.toLowerCase().includes(needle),
        );
  const current = paginate(filtered, page);

  function handleCreated(site: SiteRecord): void {
    setLastCreated(site);
    sites.setData((existing) => [site, ...existing]);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardEyebrow>Obras del alcance</CardEyebrow>
          <CardTitle as="h2">Obras</CardTitle>
          <CardDescription>
            Hasta 200 filas por respuesta, ordenadas por fecha de creación descendente. El filtro y
            la paginación son locales: MVP1 no expone cursor ni búsqueda, así que el paginador
            informa cuántas filas de la página cargada está mostrando. El alcance lo decide el API:
            el listado devuelve solo las obras del subárbol de su membresía.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="site-filter" className="sr-only">
              Filtrar por código, nombre o cliente
            </label>
            <Input
              id="site-filter"
              className="sm:max-w-xs"
              placeholder="Filtrar por código, nombre o cliente"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
              }}
            />
            <span className="tabular text-xs text-muted-foreground">
              {sites.loading
                ? 'leyendo…'
                : `${current.from}–${current.to} de ${current.total} filas${needle === '' ? '' : ` (de ${rows.length} cargadas)`}`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={sites.reload}
              disabled={sites.loading}
            >
              Actualizar
            </Button>
          </div>

          {sites.loading ? <SitesSkeleton /> : null}

          {!sites.loading && sites.failure !== null ? (
            <FailurePanel
              title="No se pudo leer la lista de obras"
              failure={sites.failure}
              onRetry={sites.reload}
            />
          ) : null}

          {!sites.loading && sites.failure === null && filtered.length === 0 ? (
            <EmptyState
              eyebrow="Sin filas"
              title={needle === '' ? 'No hay obras en el alcance' : 'El filtro no encontró filas'}
              description={
                needle === ''
                  ? 'El API respondió con una lista válida y vacía: la organización todavía no tiene obras en el subárbol de este usuario. Un rol con site.read pero fuera del subárbol recibiría scope.outside_subtree en lugar de una lista.'
                  : 'Ninguna fila cargada coincide con el texto. El filtro es local; borre el texto para volver a la lista completa.'
              }
            />
          ) : null}

          {!sites.loading && sites.failure === null && filtered.length > 0 ? (
            <>
              <ul className="flex flex-col">
                {current.items.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular font-mono text-xs text-muted-foreground">
                          {row.code}
                        </span>
                        <span className="text-[0.9375rem] font-medium">{row.name}</span>
                        <Badge variant={siteStatusVariant(row.status)}>
                          {siteStatusLabel(row.status)}
                        </Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {row.clientName} · presupuesto {formatPen(row.budgetTotal)} · inicio{' '}
                        {row.startedAt === null ? 'sin fecha' : formatUtcDate(row.startedAt.slice(0, 10))}
                      </span>
                    </div>
                    <Link
                      href={`/obras/${row.id}`}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      Abrir ficha de obra
                    </Link>
                  </li>
                ))}
              </ul>

              {current.pageCount > 1 ? (
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current.page <= 1}
                    onClick={() => setPage(current.page - 1)}
                  >
                    Anterior
                  </Button>
                  <span className="tabular text-xs text-muted-foreground">
                    Página {current.page} de {current.pageCount} · {PAGE_SIZE} filas por página
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current.page >= current.pageCount}
                    onClick={() => setPage(current.page + 1)}
                  >
                    Siguiente
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {canWrite ? (
        <SiteForm defaultOrgNodeId={knownOrgNodeId} onCreated={handleCreated} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {roleLabel(role)} no tiene <code className="font-mono">site.write</code>: el alta de obras
          no se ofrece porque el API la respondería con <code className="font-mono">access.denied</code>{' '}
          y <code className="font-mono">reason role.denied</code>.
        </p>
      )}

      {lastCreated === null ? null : (
        <p role="status" className="ob-rise text-xs text-muted-foreground">
          Última obra registrada en esta sesión:{' '}
          <span className="font-medium">{lastCreated.name}</span> ·{' '}
          <span className="tabular font-mono">{lastCreated.code}</span>
        </p>
      )}
    </div>
  );
}

/** Shaped skeleton: the same row rhythm as the real list, so nothing jumps. */
function SitesSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {[0, 1, 2, 3].map((index) => (
        <li
          key={index}
          className="flex items-center justify-between gap-4 border-b border-border py-3.5 last:border-b-0"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="ob-shimmer h-3.5 w-16" delay={index * 90} />
              <Skeleton className="ob-shimmer h-3.5 w-40" delay={index * 90} />
            </div>
            <Skeleton className="ob-shimmer h-2.5 w-56" delay={index * 90 + 60} />
          </div>
          <Skeleton className="ob-shimmer h-8 w-32 rounded-md" delay={index * 90 + 120} />
        </li>
      ))}
    </ul>
  );
}
