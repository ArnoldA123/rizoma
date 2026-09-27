'use client';

import { useState } from 'react';
import type {
  CriticalStockBoard,
  MaintenanceAssetBoard,
  SiteRecord,
  SiteStaffRecord,
  UpcomingMilestoneBoard,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FailurePanel } from '@/components/ui/states';
import { AssetsPanel } from '@/components/obras/assets-panel';
import { AttendancePanel } from '@/components/obras/attendance-panel';
import { LogsPanel } from '@/components/obras/logs-panel';
import { ProgressPanel } from '@/components/obras/progress-panel';
import { SiteBoardPanel } from '@/components/obras/site-board';
import { StaffPanel } from '@/components/obras/staff-panel';
import { StockPanel } from '@/components/obras/stock-panel';
import { ORG_SCOPED_SITE_ROLES, resolveSiteAccess } from '@/lib/access';
import { formatPen } from '@/lib/format';
import { obraDenialReasonLabel, siteStatusLabel, siteStatusVariant } from '@/lib/labels';
import { getSite, listSiteStaff } from '@/lib/obras-api';
import { currentSedeDate, formatUtcDate } from '@/lib/salud-time';
import { type ApiFailure } from '@/lib/salud-errors';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { useResource } from '@/lib/use-resource';

/**
 * `/obras/[siteId]` — the obra 360: cabecera, personal, asistencia, tablero y
 * operación (equipos, stock, avance, bitácora).
 *
 * The whole screen turns on the *two-step access key*, and the order of the
 * steps is the point:
 *
 *   1. **Open the ficha** needs `site.read` inside the membership subtree —
 *      already decided by `RouteGuard` before this component mounts, and
 *      enforced again by `GET /v1/obras/sites/:id`.
 *   2. **Operate in the obra** (personal, asistencia, tablero) additionally needs
 *      an active assignment, except for the org-scoped managers
 *      (`ORG_SCOPED_SITE_ROLES`). That second step is decided by
 *      `GET /v1/obras/sites/:siteId/staff`, which resolves `requireSiteAccess` in
 *      the service: a worker fuera de obra or with a closed assignment gets a 403
 *      `obra.scope_denied` with `reason no_active_assignment`, and this screen
 *      renders that reason instead of a button that would fail.
 *
 * `resolveSiteAccess` is evaluated here with the assignment knowledge the staff
 * list provided (`assignedSiteIds`), which is the same predicate the service
 * applies. The API remains the only authority: this is the preemptive layer, so
 * an action is hidden, never silently allowed.
 *
 * Note the honest asymmetry: the staff read is the probe for step 2, so it is the
 * one request that a non-assigned assignment-scoped role is allowed to see fail.
 * Every other operational request is mounted only after step 2 succeeded.
 *
 * The W5 operation panels follow the same rule literally: they are mounted
 * *after* `canOperate`, so a role without the assignment key never fires a
 * request the API would refuse. The conservatism is deliberate even where the
 * endpoint's own guard is weaker — a warehouse move is gated on `stock.consume`
 * at the warehouse node and does not need a site assignment, but offering it from
 * a ficha the caller cannot operate in would still be a screen full of doors that
 * do not open. The board is also the place those panels are driven from: a
 * critical item, a unit in maintenance and an upcoming milestone each carry a
 * button that selects the artefact and moves the view to the panel that operates
 * it.
 */
export interface SiteFileProps {
  readonly siteId: string;
  /** Active role driving the capability gates. */
  readonly role: string | null;
  /** Acting user id (token subject), used to detect the caller's own assignment. */
  readonly userId: string;
  /** `site.write` is not used here, but `assignment.write` is the staff gate. */
  readonly canAssign: boolean;
  /** `attendance.mark` — still needs an own assignment to actually mark. */
  readonly canMark: boolean;
  /** `attendance.approve`. */
  readonly canApprove: boolean;
  /** `site.write` — equipos (alta/estado), líneas de presupuesto e hitos. */
  readonly canWriteSite: boolean;
  /** `stock.consume` — ítems de almacén, movimientos y reversa. */
  readonly canConsumeStock: boolean;
}

export function SiteFile({
  siteId,
  role,
  userId,
  canAssign,
  canMark,
  canApprove,
  canWriteSite,
  canConsumeStock,
}: SiteFileProps) {
  const [date, setDate] = useState(() => currentSedeDate());
  // Shared selection between the board and the panels: the board is the only read
  // of the vertical that returns asset, item and milestone identifiers, so
  // picking a row is what fills these fields.
  const [assetId, setAssetId] = useState('');
  const [itemId, setItemId] = useState('');
  const [milestoneName, setMilestoneName] = useState('');
  /** Counter, not a boolean: every write asks the board for one more read. */
  const [boardNonce, setBoardNonce] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const site = useResource<SiteRecord>(`obras-site:${siteId}`, (signal) => getSite(siteId, signal));
  const staff = useResource<SiteStaffRecord[]>(`obras-staff:${siteId}`, (signal) =>
    listSiteStaff(siteId, signal),
  );

  const staffRows = staff.data ?? [];
  const ownAssignment = staffRows.some((row) => row.userId === userId && row.active);
  const decision = resolveSiteAccess({
    role: role ?? '',
    siteId,
    // The site's own node is the scope anchor here: the ficha was opened, so the
    // subtree term is isolated on purpose to expose the assignment term.
    entityOrgNodeId: siteId,
    scopeSubtree: [siteId],
    assignedSiteIds: ownAssignment ? [siteId] : [],
  });
  const assignmentDenied = staff.failure !== null && staff.failure.reason === 'no_active_assignment';
  const canOperate = !assignmentDenied && staff.failure === null && staff.data !== null && decision.allow;
  const canMarkOwn = canOperate && canMark && ownAssignment;

  /**
   * Moves the view to a panel. `scrollIntoView` is not a CSS animation, so it has
   * its own reduced-motion branch: with the preference set the jump is instant,
   * which is what «no motion» has to mean here.
   */
  function focusSection(id: string): void {
    const node = document.getElementById(id);
    if (node === null) return;
    node.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function pickItem(item: CriticalStockBoard): void {
    setItemId(item.itemId);
    focusSection('stock-obra');
  }

  function pickAsset(asset: MaintenanceAssetBoard): void {
    setAssetId(asset.assetId);
    focusSection('equipos-obra');
  }

  function pickMilestone(milestone: UpcomingMilestoneBoard): void {
    setMilestoneName(milestone.name);
    focusSection('avance-obra');
  }

  return (
    <div className="flex flex-col gap-6">
      <SiteHeader site={site.data} loading={site.loading} failure={site.failure} onRetry={site.reload} />

      {assignmentDenied && staff.failure !== null ? (
        <FailurePanel title="Sin asignación activa a esta obra" failure={staff.failure} />
      ) : null}

      {assignmentDenied ? (
        <Card tone="tinted">
          <CardHeader>
            <CardEyebrow>Clave de acceso</CardEyebrow>
            <CardTitle as="h3">La ficha abre; operar en ella es otra decisión</CardTitle>
            <CardDescription>
              {ORG_SCOPED_SITE_ROLES.includes(role ?? '')
                ? 'Su rol tiene alcance de organización y no debería necesitar asignación; si el API respondió lo contrario, revise la membresía.'
                : `Su rol (${role ?? 'sin rol'}) necesita una asignación activa en esta obra para listar personal, marcar asistencia, abrir el tablero o registrar equipos, stock, avance y bitácora. El API lo resolvió como «${obraDenialReasonLabel(staff.failure?.reason)}» y auditó la denegación.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Trabajador fuera de obra o con la asignación cerrada no marca: la fila de asignación
              sigue existiendo, pero con <code className="font-mono">active = false</code> y un
              vencimiento, que es lo que retira la clave. Pedir una asignación es la acción
              disponible; jefatura de obra y gerencia pueden crearla desde este mismo panel cuando
              tienen alcance.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <StaffPanel siteId={siteId} canAssign={canAssign} staff={staff} />

      {canOperate ? (
        <>
          <AttendancePanel
            siteId={siteId}
            date={date}
            onDateChange={setDate}
            canMark={canMarkOwn}
            canApprove={canApprove}
            canOperate={canOperate}
          />
          <SiteBoardPanel
            siteId={siteId}
            date={date}
            onPickItem={pickItem}
            onPickAsset={pickAsset}
            onPickMilestone={pickMilestone}
            refreshToken={boardNonce}
          />
          <AssetsPanel
            siteId={siteId}
            defaultOrgNodeId={site.data?.orgNodeId ?? ''}
            canWrite={canWriteSite}
            canAssign={canAssign}
            canMark={canMark}
            assetId={assetId}
            onAssetIdChange={setAssetId}
          />
          <StockPanel
            siteId={siteId}
            canConsume={canConsumeStock}
            onStockChanged={() => setBoardNonce((current) => current + 1)}
            itemId={itemId}
            onItemIdChange={setItemId}
          />
          <ProgressPanel
            siteId={siteId}
            canWrite={canWriteSite}
            canMark={canMark}
            milestoneName={milestoneName}
            onMilestoneNameChange={setMilestoneName}
            onProgressChanged={() => setBoardNonce((current) => current + 1)}
          />
          <LogsPanel siteId={siteId} canMark={canMark} />
        </>
      ) : null}
    </div>
  );
}

/** Cabecera de la obra: code, cliente, estado, presupuesto y fechas. */
function SiteHeader({
  site,
  loading,
  failure,
  onRetry,
}: {
  readonly site: SiteRecord | null;
  readonly loading: boolean;
  readonly failure: ApiFailure | null;
  readonly onRetry: () => void;
}) {
  if (loading && site === null) {
    return (
      <Card aria-hidden>
        <CardHeader>
          <Skeleton className="ob-shimmer h-3 w-24" />
          <Skeleton className="ob-shimmer mt-2 h-6 w-64" />
          <Skeleton className="ob-shimmer mt-2 h-3 w-80" delay={60} />
        </CardHeader>
      </Card>
    );
  }
  if (failure !== null) {
    return <FailurePanel title="No se pudo abrir la obra" failure={failure} onRetry={onRetry} />;
  }
  if (site === null) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardEyebrow>Obra {site.code}</CardEyebrow>
          <Badge variant={siteStatusVariant(site.status)}>{siteStatusLabel(site.status)}</Badge>
        </div>
        <CardTitle as="h2">{site.name}</CardTitle>
        <CardDescription>
          Cliente {site.clientName} · presupuesto {formatPen(site.budgetTotal)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">inicio</dt>
          <dd>{site.startedAt === null ? '—' : formatUtcDate(site.startedAt.slice(0, 10))}</dd>
          <dt className="text-muted-foreground">fin</dt>
          <dd>{site.endedAt === null ? '—' : formatUtcDate(site.endedAt.slice(0, 10))}</dd>
          <dt className="text-muted-foreground">nodo</dt>
          <dd className="font-mono text-muted-foreground break-all">{site.orgNodeId.slice(0, 8)}…</dd>
          <dt className="text-muted-foreground">obra</dt>
          <dd className="font-mono text-muted-foreground break-all">{site.id.slice(0, 8)}…</dd>
        </dl>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
            Copiar detalle
          </summary>
          <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
            {`siteId: ${site.id}\norgNodeId: ${site.orgNodeId}`}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
