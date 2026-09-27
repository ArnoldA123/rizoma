'use client';

import { useEffect, useState } from 'react';
import type { AttendanceRecord } from '@rizoma/contracts';
import { attendanceListSchema, attendanceQueryString } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { ViewSelector } from '@/components/views/view-selector';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { requestJson } from '@/lib/api-client';
import { withSavedView } from '@/lib/views-api';
import { formatSedeStamp } from '@/lib/format';
import { attendanceStatusLabel, attendanceStatusVariant } from '@/lib/labels';
import { approveAttendance, listSiteStaff, markAttendance } from '@/lib/obras-api';
import { listOrgNodes } from '@/lib/org-api';
import type { OrgNodeRecord } from '@rizoma/contracts';
import {
  currentSedeDate,
  formatUtcDateLong,
  isCurrentSedeDate,
  resolveSedeTimezone,
  shiftUtcDate,
} from '@/lib/salud-time';
import { useResource } from '@/lib/use-resource';

/**
 * Asistencia del día: the day's marks, the own mark and the approval.
 *
 * Three rules of the service drive this panel, and each one is rendered instead
 * of assumed:
 *
 *   1. **The own mark needs an active assignment, whatever the role.** The
 *      service resolves `activeAssignment(caller, site)` before inserting, so
 *      `gerente` and `jefe_obra` are *not* exempt: `canMark` is therefore
 *      `attendance.mark` **and** an assignment of the caller's own in the staff
 *      list. A worker fuera de obra or with a closed assignment sees the reason,
 *      not a button that would fail.
 *   2. **The mark is the caller's own.** `userId` is never sent: the service
 *      denies a foreign subject with `obra.access_denied` / `attendance.not_own`.
 *   3. **Approval is a separate authority.** `attendance.approve` is not in the
 *      worker or almacén matrix, so the action is not rendered for them at all.
 *      `capataz` only approves the crew it leads and `jefe_obra` only inside its
 *      own sites — the API reports `crew.mismatch` or `site.out_of_scope` when
 *      the row is outside that reach, and the panel surfaces that envelope.
 */
export interface AttendancePanelProps {
  readonly siteId: string;
  /** `YYYY-MM-DD` day the panel reads; owned by the ficha. */
  readonly date: string;
  readonly onDateChange: (date: string) => void;
  /** `attendance.mark` and an active assignment of the caller in this obra. */
  readonly canMark: boolean;
  /** `attendance.approve` — capataz, jefe de obra or gerencia. */
  readonly canApprove: boolean;
  /** Whether the caller may operate in the obra at all (assignment key). */
  readonly canOperate: boolean;
  readonly className?: string;
}

export function AttendancePanel({
  siteId,
  date,
  onDateChange,
  canMark,
  canApprove,
  canOperate,
  className,
}: AttendancePanelProps) {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // The active saved view narrows the server list via `?saved_view_id=`; null
  // reads the unfiltered day. The id joins the resource key so a pick
  // refetches through the same abort-safe path as a day change.
  const [viewId, setViewId] = useState<string | null>(null);

  // The panel owns its read and is mounted only once the ficha confirmed the
  // caller can operate in the obra, so a role without the assignment key never
  // fires a request the API would refuse.
  const attendance = useResource<AttendanceRecord[]>(
    `obras-attendance:${siteId}:${date}:${viewId ?? ''}`,
    (signal) => readAttendance(siteId, date, viewId, signal),
  );

  const rows = attendance.data ?? [];
  const registered = rows.filter((row) => row.status === 'registered').length;
  // The sede travels as a parameter: first sede zone from the org tree, Lima
  // fallback while the list loads or when the row has no zone.
  const [sedeNodes, setSedeNodes] = useState<readonly OrgNodeRecord[]>([]);
  const sedeTimezone = resolveSedeTimezone(sedeNodes);

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
  // Worker names resolve in the browser against the site staff list: the
  // day endpoint carries only user ids. A failed read leaves the map empty
  // and the row falls back to the short id — the list never blocks on it.
  const [staffNames, setStaffNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listSiteStaff(siteId, controller.signal)
      .then((staff) => {
        if (!active) return;
        setStaffNames(new Map(staff.map((row) => [row.userId, row.userName])));
      })
      .catch(() => {
        if (active) setStaffNames(new Map());
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [siteId]);

  async function handleMark(): Promise<void> {
    setFailure(null);
    setSuccess(null);
    setSaving(true);
    try {
      const mark = await markAttendance({ siteId });
      // A mark always lands on *today*: if the panel is showing another day, move
      // to today so the row the user just created is on screen. The key change
      // refetches the day; the extra silent reload is a no-op when it is already
      // today.
      if (!isCurrentSedeDate(date, sedeTimezone)) onDateChange(currentSedeDate(sedeTimezone));
      attendance.reloadSilently();
      setSuccess(
        `Asistencia marcada (${formatSedeStamp(mark.checkIn, sedeTimezone)}). Queda en estado «Registrada» hasta que capataz o jefatura la apruebe.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove(row: AttendanceRecord): Promise<void> {
    setFailure(null);
    setSuccess(null);
    try {
      await approveAttendance(row.id);
      attendance.reloadSilently();
      setSuccess('Marca aprobada. La aprobación es idempotente por estado: una marca que ya no está registrada no se puede aprobar de nuevo.');
    } catch (error) {
      setFailure(classifyApiError(error));
    }
  }

  return (
    <Card className={className} id="asistencia-obra">
      <CardHeader>
        <CardEyebrow>Asistencia</CardEyebrow>
        <CardTitle as="h2">{formatUtcDateLong(date)}</CardTitle>
        <CardDescription>
          El día es el de la sede, igual que el filtro de la agenda de salud y el tablero de obra.
          Marcar es una acción propia: el API resuelve el sujeto del token y rechaza cualquier
          otro <code className="font-mono text-xs">userId</code>.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <ViewSelector entity="attendance" selectedId={viewId} onSelect={setViewId} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onDateChange(shiftUtcDate(date, -1))}>
            Día anterior
          </Button>
          <Button
            variant={isCurrentSedeDate(date, sedeTimezone) ? 'ghost' : 'outline'}
            size="sm"
            disabled={isCurrentSedeDate(date, sedeTimezone)}
            onClick={() => onDateChange(currentSedeDate(sedeTimezone))}
          >
            Hoy
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDateChange(shiftUtcDate(date, 1))}>
            Día siguiente
          </Button>
          <label htmlFor="attendance-date" className="sr-only">
            Día de asistencia
          </label>
          <Input
            id="attendance-date"
            type="date"
            className="w-40"
            value={date}
            onChange={(event) => {
              if (event.target.value !== '') onDateChange(event.target.value);
            }}
          />
          <span className="tabular ml-auto text-xs text-muted-foreground">
            {attendance.loading
              ? 'leyendo…'
              : `${rows.length} marcas · ${registered} por aprobar`}
          </span>
          <Button variant="ghost" size="sm" onClick={attendance.reload} disabled={attendance.loading}>
            Actualizar
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {canMark ? (
            <Button variant="primary" size="sm" onClick={() => void handleMark()} disabled={saving}>
              {saving ? 'Marcando…' : 'Marcar mi asistencia'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              {canOperate
                ? 'Su rol no marca asistencia o no tiene una asignación activa propia en esta obra: el API respondería obra.access_denied con reason no_active_assignment. Gerencia y jefatura tampoco están exentas de la asignación para marcar.'
                : 'Marcar exige una asignación activa a esta obra. El API resuelve esa clave antes de insertar la marca, así que la acción no se ofrece.'}
            </p>
          )}
          {canApprove ? (
            <p className="text-xs text-muted-foreground sm:ml-auto">
              Aprobar: <code className="font-mono">attendance.approve</code> está en su rol. Capataz
              solo aprueba su cuadrilla y jefatura de obra solo sus obras; fuera de ese alcance el
              API responde <code className="font-mono">obra.approve_denied</code>.
            </p>
          ) : null}
        </div>

        <WriteResult failure={failure} success={success} />

        {attendance.loading ? <AttendanceSkeleton /> : null}

        {!attendance.loading && attendance.failure !== null ? (
          <FailurePanel
            title="No se pudo leer la asistencia del día"
            failure={attendance.failure}
            onRetry={attendance.reload}
          />
        ) : null}

        {!attendance.loading && attendance.failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin marcas"
            title="No hay asistencia registrada este día"
            description="El API respondió con una lista válida y vacía para la obra y el día consultados. Una marca fuera de obra o con la asignación vencida no se crea, así que no aparece aquí."
          />
        ) : null}

        {!attendance.loading && attendance.failure === null && rows.length > 0 ? (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.8125rem] font-medium">
                      {staffNames.get(row.userId) ?? `Trabajador ${row.userId.slice(0, 8)}…`}
                    </span>
                    <Badge variant={attendanceStatusVariant(row.status)}>
                      {attendanceStatusLabel(row.status)}
                    </Badge>
                  </div>
                  <span className="tabular text-xs text-muted-foreground">
                    ingreso {formatSedeStamp(row.checkIn, sedeTimezone)} · salida{' '}
                    {row.checkOut === null ? '—' : formatSedeStamp(row.checkOut, sedeTimezone)} · origen{' '}
                    {row.source}
                  </span>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    marca {row.id.slice(0, 8)}… · usuario {row.userId.slice(0, 8)}…
                  </span>
                </div>
                {canApprove && row.status === 'registered' ? (
                  <Button variant="outline" size="sm" onClick={() => void handleApprove(row)}>
                    Aprobar
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Reads the day list through the proxy, narrowed by the active saved view.
 * `site` and `date` stay required: the API still rejects a missing day, and
 * the view only ANDs its exact-equality bag onto that scope.
 */
async function readAttendance(
  siteId: string,
  date: string,
  savedViewId: string | null,
  signal: AbortSignal,
): Promise<AttendanceRecord[]> {
  const rows = await requestJson(
    attendancePath(siteId, date, savedViewId),
    attendanceListSchema,
    { signal },
  );
  return rows ?? [];
}

/**
 * Path of `GET /v1/obras/attendance` carrying `site`+`date` and the optional
 * `?saved_view_id=` suffix named once by `withSavedView`.
 */
function attendancePath(siteId: string, date: string, savedViewId: string | null): string {
  const base = withSavedView('/obras/attendance', savedViewId);
  const rest = attendanceQueryString({ site: siteId, date });
  if (rest === '') return base;
  return `${base}${base.includes('?') ? '&' : '?'}${rest.slice(1)}`;
}

function AttendanceSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {[0, 1, 2].map((index) => (
        <li key={index} className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
          <div className="flex flex-col gap-2">
            <Skeleton className="ob-shimmer h-3.5 w-56" delay={index * 90} />
            <Skeleton className="ob-shimmer h-2.5 w-72" delay={index * 90 + 60} />
          </div>
          <Skeleton className="ob-shimmer h-8 w-24 rounded-md" delay={index * 90 + 120} />
        </li>
      ))}
    </ul>
  );
}
