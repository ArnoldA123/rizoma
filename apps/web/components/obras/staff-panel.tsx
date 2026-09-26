'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  SITE_ROLE_MAX,
  checkOptionalUuidField,
  checkRequiredText,
  checkUuidField,
  firstIssue,
  type FieldCheck,
  type SiteStaffRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldMessage } from '@/components/ui/field-feedback';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Skeleton } from '@/components/ui/skeleton';
import { MagneticCta } from '@/components/ui/magnetic';
import { EmptyState, FailurePanel, WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { SITE_ROLE_SUGGESTIONS } from '@/lib/labels';
import { assignWorker, closeAssignment } from '@/lib/obras-api';
import { listUsers } from '@/lib/users-api';
import type { Resource } from '@/lib/use-resource';
import { formatUtcDate } from '@/lib/salud-time';

/**
 * Personal de la obra: active assignments, the assignment form and the close
 * action.
 *
 * Authority here is `assignment.write`, which only `gerente` and `jefe_obra`
 * hold — and both are org-scoped, so this panel is the "manager" half of the
 * two-step rule. The other half (the active-assignment key) is why the parent
 * ficha renders this panel only after `GET .../staff` confirmed the caller can
 * operate in the obra at all.
 *
 * Two rules of the service are mirrored, not re-invented:
 *   - assigning is idempotent by `user + site`: the service returns the
 *     assignment already in force instead of duplicating it, so a double submit
 *     is harmless;
 *   - closing sets `active = FALSE` and `valid_to = now()`, which revokes the
 *     worker's site access on the next decision — the UI says so instead of
 *     implying the row merely disappears.
 */
export interface StaffPanelProps {
  readonly siteId: string;
  /** `assignment.write` — may assign and close. */
  readonly canAssign: boolean;
  /** The active assignments read by the ficha. */
  readonly staff: Resource<SiteStaffRecord[]>;
  readonly className?: string;
}

interface Draft {
  userId: string;
  crewId: string;
  roleInSite: string;
}

const EMPTY_DRAFT: Draft = { userId: '', crewId: '', roleInSite: '' };

export function StaffPanel({ siteId, canAssign, staff, className }: StaffPanelProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [workerItems, setWorkerItems] = useState<readonly EntityItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listUsers({}, controller.signal)
      .then((rows) => {
        if (!active) return;
        setWorkerItems(rows.map((row) => ({ id: row.id, label: row.name, sub: row.email })));
      })
      .catch(() => {
        if (active) setWorkerItems([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const checks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      userId: checkUuidField('userId', draft.userId),
      crewId: checkOptionalUuidField('crewId', draft.crewId),
      roleInSite: checkRequiredText('roleInSite', draft.roleInSite, SITE_ROLE_MAX),
    }),
    [draft],
  );

  const rows = staff.data ?? [];
  const show = (field: string): boolean => touched[field] === true || submitted;

  function set<K extends keyof Draft>(field: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setSuccess(null);
  }

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function handleAssign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setFailure(null);
    setSuccess(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const crew = draft.crewId.trim();
      const assignment = await assignWorker(siteId, {
        userId: draft.userId.trim(),
        crewId: crew === '' ? null : crew,
        roleInSite: draft.roleInSite.trim(),
      });
      staff.reloadSilently();
      const workerName =
        workerItems.find((item) => item.id === assignment.userId)?.label ?? assignment.userId;
      setSuccess(
        `Asignación activa para ${workerName} como ${assignment.roleInSite}. Si ya existía, el API devolvió la asignación en vigor sin duplicarla.`,
      );
      setDraft(EMPTY_DRAFT);
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleClose(row: SiteStaffRecord): Promise<void> {
    setFailure(null);
    setSuccess(null);
    try {
      await closeAssignment(siteId, row.userId);
      staff.reloadSilently();
      setSuccess(
        `Asignación de ${row.userName} cerrada. El trabajador deja de tener la clave de acceso a esta obra en la siguiente decisión del API.`,
      );
    } catch (error) {
      setFailure(classifyApiError(error));
    }
  }

  return (
    <Card className={className} id="personal-obra">
      <CardHeader>
        <CardEyebrow>Personal</CardEyebrow>
        <CardTitle as="h2">Asignaciones activas</CardTitle>
        <CardDescription>
          Solo las asignaciones en vigor. Cerrar una asignación no borra la fila: la marca como
          inactiva y fija su vencimiento, que es lo que retira la clave de acceso del trabajador.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {staff.loading ? <StaffSkeleton /> : null}

        {!staff.loading && staff.failure !== null ? (
          <FailurePanel
            title="No se pudo leer el personal de la obra"
            failure={staff.failure}
            onRetry={staff.reload}
          />
        ) : null}

        {!staff.loading && staff.failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin asignaciones"
            title="La obra no tiene personal asignado"
            description="El API respondió con una lista válida y vacía. Mientras no exista una asignación activa, un rol cuyo alcance dependa de la asignación no podrá marcar asistencia ni abrir el tablero de esta obra."
          />
        ) : null}

        {!staff.loading && staff.failure === null && rows.length > 0 ? (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.9375rem] font-medium">{row.userName}</span>
                    <Badge variant="outline">{row.roleInSite}</Badge>
                    {row.crewName === null ? null : (
                      <Badge variant="neutral">{row.crewName}</Badge>
                    )}
                  </div>
                  <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
                    usuario {row.userId.slice(0, 8)}…
                    {row.validFrom === null ? '' : ` · desde ${formatUtcDate(row.validFrom.slice(0, 10))}`}
                  </span>
                </div>
                {canAssign ? (
                  <Button variant="outline" size="sm" onClick={() => void handleClose(row)}>
                    Cerrar asignación
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canAssign ? (
          <form className="flex flex-col gap-4 border-t border-border pt-4" onSubmit={handleAssign} noValidate>
            <p className="text-xs text-muted-foreground">
              Asignar exige <code className="font-mono">assignment.write</code> y que el trabajador
              tenga una membresía activa en el tenant; sin ella el API responde{' '}
              <code className="font-mono">obra.membership_required</code>.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <EntitySelector
                  label="Trabajador"
                  items={workerItems}
                  value={draft.userId === '' ? null : draft.userId}
                  onChange={(id) => {
                    set('userId', id ?? '');
                    touch('userId');
                  }}
                  placeholder="Seleccionar trabajador…"
                  searchPlaceholder="Buscar por nombre…"
                />
                <FieldMessage issue={checks.userId ?? null} touched={show('userId')} validLabel="Dato aceptado." />
              </div>
              <LiveField id="staff-crew" label="Cuadrilla (opcional)" issue={checks.crewId ?? null} touched={show('crewId')}>
                <Input
                  id="staff-crew"
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder="UUID de cuadrilla"
                  value={draft.crewId}
                  onChange={(event) => set('crewId', event.target.value)}
                  onBlur={() => touch('crewId')}
                />
              </LiveField>
              <LiveField id="staff-role" label="Rol en la obra" issue={checks.roleInSite ?? null} touched={show('roleInSite')}>
                <Input
                  id="staff-role"
                  list="staff-role-suggestions"
                  autoComplete="off"
                  maxLength={SITE_ROLE_MAX}
                  placeholder="capataz"
                  value={draft.roleInSite}
                  onChange={(event) => set('roleInSite', event.target.value)}
                  onBlur={() => touch('roleInSite')}
                />
              </LiveField>
            </div>
            <datalist id="staff-role-suggestions">
              {SITE_ROLE_SUGGESTIONS.map((role) => (
                <option key={role} value={role} />
              ))}
            </datalist>

            <div>
              <MagneticCta type="submit" disabled={saving}>
                {saving ? 'Asignando…' : 'Asignar trabajador'}
              </MagneticCta>
            </div>

            <WriteResult failure={failure} success={success} />
          </form>
        ) : (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Su rol no puede asignar personal ni cerrar asignaciones en esta obra: esas opciones
              no se ofrecen. Si necesita este acceso, avise a jefatura o a soporte.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                Copiar detalle
              </summary>
              <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                {`code: obra.scope_denied\nstatus: 403\naction: assignment.write`}
              </pre>
            </details>
            <WriteResult failure={failure} success={success} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StaffSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {[0, 1].map((index) => (
        <li key={index} className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
          <div className="flex flex-col gap-2">
            <Skeleton className="ob-shimmer h-3.5 w-40" delay={index * 90} />
            <Skeleton className="ob-shimmer h-2.5 w-56" delay={index * 90 + 60} />
          </div>
          <Skeleton className="ob-shimmer h-8 w-36 rounded-md" delay={index * 90 + 120} />
        </li>
      ))}
    </ul>
  );
}

/** Field wrapper with a live verdict, mirroring the salud forms. */
function LiveField({
  id,
  label,
  issue,
  touched,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly issue: FieldCheck;
  readonly touched: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
        {label}
      </label>
      {children}
      <FieldMessage issue={issue} touched={touched} />
    </div>
  );
}
