'use client';

import { useState } from 'react';
import type { AttendanceRecord } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { formatUtcStamp } from '@/lib/format';
import { attendanceStatusLabel, attendanceStatusVariant } from '@/lib/labels';
import { approveAttendance, listAttendance, markAttendance } from '@/lib/obras-api';
import { currentUtcDate, formatUtcDateLong, isCurrentUtcDate, shiftUtcDate } from '@/lib/salud-time';
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

  // The panel owns its read and is mounted only once the ficha confirmed the
  // caller can operate in the obra, so a role without the assignment key never
  // fires a request the API would refuse.
  const attendance = useResource<AttendanceRecord[]>(
    `obras-attendance:${siteId}:${date}`,
    (signal) => listAttendance({ site: siteId, date }, signal),
  );

  const rows = attendance.data ?? [];
  const registered = rows.filter((row) => row.status === 'registered').length;

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
      if (!isCurrentUtcDate(date)) onDateChange(currentUtcDate());
      attendance.reloadSilently();
      setSuccess(
        `Asistencia marcada (${formatUtcStamp(mark.checkIn)}). Queda en estado «Registrada» hasta que capataz o jefatura la apruebe.`,
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
          El día es UTC, igual que el filtro de la agenda de salud y el tablero de obra. Marcar es
          una acción propia: el API resuelve el sujeto del token y rechaza cualquier otro{' '}
          <code className="font-mono text-xs">userId</code>.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onDateChange(shiftUtcDate(date, -1))}>
            Día anterior
          </Button>
          <Button
            variant={isCurrentUtcDate(date) ? 'ghost' : 'outline'}
            size="sm"
            disabled={isCurrentUtcDate(date)}
            onClick={() => onDateChange(currentUtcDate())}
          >
            Hoy (UTC)
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
                    <span className="tabular font-mono text-xs">{row.userId}</span>
                    <Badge variant={attendanceStatusVariant(row.status)}>
                      {attendanceStatusLabel(row.status)}
                    </Badge>
                  </div>
                  <span className="tabular text-xs text-muted-foreground">
                    ingreso {formatUtcStamp(row.checkIn)} · salida{' '}
                    {row.checkOut === null ? '—' : formatUtcStamp(row.checkOut)} · origen {row.source}
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
