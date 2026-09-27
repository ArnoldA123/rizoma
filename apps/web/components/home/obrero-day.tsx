'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AttendanceRecord, OrgNodeRecord, SiteRecord } from '@rizoma/contracts';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { EntitySelector } from '@/components/ui/entity-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonRows } from '@/components/ui/skeleton';
import { IconArrowRight } from '@/components/ui/icons';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatSedeStamp } from '@/lib/format';
import { attendanceStatusLabel } from '@/lib/labels';
import { listAttendance, listSites, markAttendance } from '@/lib/obras-api';
import { listOrgNodes } from '@/lib/org-api';
import { currentSedeDate, formatUtcDateLong, resolveSedeTimezone } from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';
import type { HomeLink } from './role-home';

export interface ObreroDayProps {
  /** User id of the session, used to focus the worker's own mark of today. */
  readonly viewerId: string | null;
  readonly links: readonly HomeLink[];
}

/**
 * Day cover of the trabajador role (P3-1b).
 *
 * The mark comes first: one button marks the caller's own attendance at the
 * focused obra, and the service resolves the subject from the token — the body
 * never carries a user id. A scope without obras means no active assignment,
 * so the cover says so and asks the worker to request one instead of offering
 * a button the API would refuse. Names own every row — no identifier is
 * rendered.
 */
export function ObreroDay({ viewerId, links }: ObreroDayProps) {
  const sites = useResource<SiteRecord[]>('home-sites:trabajador', (signal) =>
    listSites(signal),
  );
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

  const attendance = useResource<AttendanceRecord[]>(
    `home-attendance:${activeId ?? 'none'}:${today}`,
    (signal) =>
      activeId === null
        ? Promise.resolve([])
        : listAttendance({ site: activeId, date: today }, signal),
  );
  const ownRows =
    viewerId === null
      ? []
      : (attendance.data ?? []).filter((row) => row.userId === viewerId);
  const ownMark = ownRows[0] ?? null;

  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleMark(): Promise<void> {
    if (activeId === null) return;
    setFailure(null);
    setSuccess(null);
    setSaving(true);
    try {
      const mark = await markAttendance({ siteId: activeId });
      attendance.reloadSilently();
      setSuccess(
        `Asistencia marcada (${formatSedeStamp(mark.checkIn, sedeTimezone)}). Queda en estado «Registrada» hasta que su capataz la apruebe.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Mi día · hoy"
        title={active === null ? 'Marcar mi asistencia' : `Hoy en ${active.name}`}
        description={`${formatUtcDateLong(today)}: marque su asistencia primero; abajo ve su estado de hoy.`}
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
          eyebrow="Sin obra asignada"
          title="Aún no tiene una obra asignada"
          description="El API respondió con una lista válida y vacía: marcar asistencia exige una asignación activa, así que pida que lo asignen a su obra antes de marcar."
        />
      ) : null}

      {activeId === null || active === null ? null : (
        <>
          {rows.length > 1 ? (
            <Card>
              <CardContent className="pt-6">
                <EntitySelector
                  label="Obra"
                  items={rows.map((row) => ({
                    id: row.id,
                    label: `${row.code} · ${row.name}`,
                    sub: row.clientName,
                  }))}
                  value={activeId}
                  onChange={setSelectedId}
                  placeholder="Seleccionar obra…"
                  searchPlaceholder="Buscar obra…"
                />
              </CardContent>
            </Card>
          ) : null}

          <Card tone="tinted">
            <CardHeader>
              <CardEyebrow>Asistencia</CardEyebrow>
              <CardTitle as="h2">Marcar mi asistencia</CardTitle>
              <CardDescription>
                La marca es personal: el API la registra a su nombre y la deja en estado
                «Registrada». Si su asignación terminó, la marca se deniega y debe pedir que lo
                asignen de nuevo.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleMark()}
                  disabled={saving}
                >
                  {saving ? 'Marcando…' : 'Marcar mi asistencia'}
                </Button>
              </div>
              <WriteResult failure={failure} success={success} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardEyebrow>Estado de hoy</CardEyebrow>
              <CardTitle as="h2">Su marca de hoy</CardTitle>
              <CardDescription>
                Su estado de hoy en {active.code}. La lista completa del día vive en la ficha de
                la obra.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {attendance.loading && ownMark === null ? <SkeletonRows rows={1} /> : null}
              {!attendance.loading && attendance.failure !== null ? (
                <FailurePanel
                  title="No se pudo leer su marca"
                  failure={attendance.failure}
                  onRetry={attendance.reload}
                />
              ) : null}
              {!attendance.loading && attendance.failure === null && ownMark === null ? (
                <p className="text-muted-foreground">
                  Aún no marcó su asistencia hoy. Use el botón de arriba para registrar su ingreso.
                </p>
              ) : null}
              {ownMark === null ? null : (
                <p className="text-[0.8125rem]">
                  Ingreso {formatSedeStamp(ownMark.checkIn, sedeTimezone)} · estado{' '}
                  {attendanceStatusLabel(ownMark.status)}
                  {ownMark.checkOut === null
                    ? ''
                    : ` · salida ${formatSedeStamp(ownMark.checkOut, sedeTimezone)}`}
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <EnabledScreens links={links} />
    </div>
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
