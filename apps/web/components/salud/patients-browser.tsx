'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PatientRecord } from '@rizoma/contracts';
import { patientListSchema } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { PatientForm } from '@/components/salud/patient-form';
import { ViewSelector } from '@/components/views/view-selector';
import { EmptyState, FailurePanel } from '@/components/salud/states';
import { DEV_IDENTITY } from '@/lib/config';
import { requestJson } from '@/lib/api-client';
import { withSavedView } from '@/lib/views-api';
import { documentTypeLabel, roleLabel } from '@/lib/labels';
import { PAGE_SIZE, paginate } from '@/lib/salud-select';
import { formatUtcDate } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * `/salud/pacientes` — the patient list and the registration form.
 *
 * The screen hosts two capabilities with two different grants, which is exactly
 * why the route is `any(patient.read, patient.write)`:
 *
 *   - `patient.read` gates the *list*. Reception does not hold it, so reception
 *     gets no list — the API would answer 403 `role.denied` on
 *     `GET /v1/salud/patients` and the UI does not offer a call it knows will
 *     fail. What reception gets instead is the registration form plus the
 *     confirmation of what it just registered.
 *   - `patient.write` gates the *form*. A read-only role (enfermería) sees the
 *     list and no form.
 *
 * Two honest notes on the data path:
 *   - the API caps every list at 200 rows and offers no cursor and no search, so
 *     pagination and the text filter run **in the browser** over the loaded page
 *     of rows — the paginator says so instead of implying server paging;
 *   - `GET /v1/salud/patients` replies with an *untyped* 500 when the caller has
 *     no `memberships` row (a base gap, reported and not fixed here), so the list
 *     renders a typed error state with the envelope it can state and the trace id
 *     it received, rather than a generic "error".
 */
/**
 * Reads the patient list through the proxy, narrowed by the active saved view.
 * The API applies the view's exact-equality bag server-side; a missing view is
 * 404 and an entity mismatch is 400, both surfaced as a typed failure panel.
 */
async function readPatients(
  savedViewId: string | null,
  signal: AbortSignal,
): Promise<PatientRecord[]> {
  const rows = await requestJson(
    withSavedView('/salud/patients', savedViewId),
    patientListSchema,
    { signal },
  );
  return rows ?? [];
}

export interface PatientsBrowserProps {
  readonly role: string | null;
  /** `patient.read` — the role may list and open patient files. */
  readonly canRead: boolean;
  /** `patient.write` — the role may register and edit patient files. */
  readonly canWrite: boolean;
}

export function PatientsBrowser({ role, canRead, canWrite }: PatientsBrowserProps) {
  // The active saved view narrows the server list via `?saved_view_id=`; null
  // reads the unfiltered scope. The id joins the resource key so a pick
  // refetches through the same abort-safe path as every other list read.
  const [viewId, setViewId] = useState<string | null>(null);
  // The list is only requested when the role may read it. A role without
  // `patient.read` must not fire a call the guard mirror already knows the API
  // would answer with 403 `role.denied`: the empty promise is the honest
  // "nothing to read", and the screen says why instead of showing an error it
  // caused itself.
  const patients = useResource<PatientRecord[]>(`patients:${viewId ?? ''}`, (signal) =>
    canRead ? readPatients(viewId, signal) : Promise.resolve([]),
  );
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  /** Last row created in this session, for the roles that cannot list. */
  const [lastCreated, setLastCreated] = useState<PatientRecord | null>(null);

  const rows = patients.data ?? [];
  const knownOrgNodeId = rows[0]?.orgNodeId ?? DEV_IDENTITY.orgNodeId;
  const needle = filter.trim().toLowerCase();
  const filtered =
    needle === ''
      ? rows
      : rows.filter(
          (row) =>
            row.personName.toLowerCase().includes(needle) ||
            row.documentNumber.toLowerCase().includes(needle),
        );
  const current = paginate(filtered, page);

  function handleCreated(patient: PatientRecord): void {
    setLastCreated(patient);
    patients.setData((existing) => [patient, ...existing]);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-6">
      {canRead ? (
        <Card>
          <CardHeader>
            <CardEyebrow>Fichas del alcance</CardEyebrow>
            <CardTitle as="h2">Pacientes</CardTitle>
            <CardDescription>
              Hasta 200 filas por respuesta, ordenadas por fecha de creación descendente. La
              paginación y el filtro son locales: el API no expone cursor ni búsqueda en MVP1, así
              que el paginador informa cuántas filas de la página cargada está mostrando.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <ViewSelector
              entity="patients"
              selectedId={viewId}
              onSelect={(next) => {
                setViewId(next);
                setPage(1);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="patient-filter" className="sr-only">
                Filtrar por nombre o documento
              </label>
              <Input
                id="patient-filter"
                className="sm:max-w-xs"
                placeholder="Filtrar por nombre o documento"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setPage(1);
                }}
              />
              <span className="tabular text-xs text-muted-foreground">
                {patients.loading
                  ? 'leyendo…'
                  : `${current.from}–${current.to} de ${current.total} filas${needle === '' ? '' : ` (de ${rows.length} cargadas)`}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={patients.reload}
                disabled={patients.loading}
              >
                Actualizar
              </Button>
            </div>

            {patients.loading ? <SkeletonRows rows={6} /> : null}

            {!patients.loading && patients.failure !== null ? (
              <div className="flex flex-col gap-4">
                <FailurePanel
                  title="No se pudo leer la lista de pacientes"
                  failure={patients.failure}
                  onRetry={patients.reload}
                />
                <EmptyState
                  eyebrow="Estado tipificado"
                  title="Sin filas que mostrar"
                  description="La pantalla no inventa filas ni reintenta en silencio: sin una respuesta válida no hay lista. El registro sigue disponible si su rol tiene patient.write."
                />
              </div>
            ) : null}

            {!patients.loading && patients.failure === null && filtered.length === 0 ? (
              <EmptyState
                eyebrow="Sin filas"
                title={needle === '' ? 'No hay pacientes en el alcance' : 'El filtro no encontró filas'}
                description={
                  needle === ''
                    ? 'El API respondió con una lista válida y vacía: la organización todavía no tiene fichas registradas en el alcance de este usuario.'
                    : 'Ninguna fila cargada coincide con el texto. El filtro es local; borre el texto para volver a la lista completa.'
                }
              />
            ) : null}
            {!patients.loading && patients.failure === null && filtered.length > 0 ? (
              <>
                <ul className="flex flex-col">
                  {current.items.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0"
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[0.9375rem] font-medium">{row.personName}</span>
                          {row.active ? null : <Badge variant="danger">Inactiva</Badge>}
                          {row.allergies.length === 0 ? null : (
                            <Badge variant="danger" title={row.allergies.join(', ')}>
                              Alergias: {row.allergies.length}
                            </Badge>
                          )}
                        </div>
                        <span className="tabular font-mono text-xs text-muted-foreground">
                          {documentTypeLabel(row.documentType)} {row.documentNumber} ·{' '}
                          {row.birthdate === null ? 'sin fecha de nacimiento' : formatUtcDate(row.birthdate)}
                        </span>
                      </div>
                      <Link
                        href={`/salud/pacientes/${row.id}`}
                        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                      >
                        Abrir ficha 360
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
      ) : null}

      {canRead ? null : (
        <EmptyState
          eyebrow="Capacidad separada"
          title={`${roleLabel(role)} no lista fichas existentes`}
          description="El rol no tiene patient.read, así que la lista no se ofrece: GET /v1/salud/patients respondería 403 con code access.denied y reason role.denied. Sí puede registrar una ficha nueva, y la confirmación de abajo es lo que queda a la vista."
        >
          {lastCreated === null ? (
            <p className="text-xs text-muted-foreground">
              Todavía no hay una ficha registrada en esta sesión.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-[0.8125rem]">
                Última ficha registrada en esta sesión:{' '}
                <span className="font-medium">{lastCreated.personName}</span> ·{' '}
                <span className="tabular font-mono text-xs">
                  {documentTypeLabel(lastCreated.documentType)} {lastCreated.documentNumber}
                </span>
              </p>
              <p className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                id {lastCreated.id}
              </p>
            </div>
          )}
        </EmptyState>
      )}

      {canWrite ? (
        <PatientForm
          role={role}
          defaultOrgNodeId={knownOrgNodeId}
          canOpenFile={canRead}
          onCreated={handleCreated}
        />
      ) : null}

      {canWrite ? null : (
        <p className="text-xs text-muted-foreground">
          Su rol no tiene <code className="font-mono">patient.write</code>: la ficha se muestra en
          modo lectura y el formulario de registro no está disponible.
        </p>
      )}
    </div>
  );
}
