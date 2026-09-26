import '../obras.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { SiteFile } from '@/components/obras/site-file';
import { ORG_SCOPED_SITE_ROLES, resolveSiteAccess } from '@/lib/access';
import { can } from '@/lib/navigation';
import { roleLabel } from '@/lib/labels';

/**
 * `/obras/[siteId]` — the obra 360 (W4 + W5).
 *
 * The route opens on `site.read` inside the subtree (`GET /v1/obras/sites/:id`
 * behaves that way), while the operational panels below it additionally require
 * the assignment key (`requireSiteAccess`: staff, attendance, board). The page
 * makes that two-step rule visible with the same predicate the API applies, and
 * `SiteFile` then decides the second step against the *real* assignment list it
 * read — see its module doc for the honest asymmetry of that probe.
 *
 * The table below stays deliberately hypothetical (zero active assignments): it
 * is the rule, not the state of this session. The live decision is the one the
 * panel renders.
 *
 * W5 adds the operation half — equipos, stock, avance y bitácora — under the
 * same key: `SiteFile` mounts those panels only after the staff read proved the
 * caller can operate in the obra. The `canX` props below are capabilities the
 * guard already decided; the browser re-renders affordances, never rules.
 */
export const dynamic = 'force-dynamic';

/** Construction roles whose reach depends on an active assignment. */
const ASSIGNMENT_SCOPED_ROLES: readonly string[] = ['almacen', 'capataz', 'trabajador', 'auditor'];

export default async function ObraSitePage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Obras · ficha"
        title="Ficha de obra"
        description="Cabecera, personal asignado, asistencia del día, tablero de la obra y operación: equipos, stock, avance y bitácora."
        badges={['obras']}
      />

      <RouteGuard path="/obras/[siteId]">
        {(guard) => {
          const identity = guard.session.identity;
          return (
            <div className="flex flex-col gap-5">
              <SiteFile
                siteId={siteId}
                role={guard.role}
                userId={identity.ok ? identity.identity.userId : ''}
                canAssign={can(guard.role ?? '', 'assignment.write')}
                canMark={can(guard.role ?? '', 'attendance.mark')}
                canApprove={can(guard.role ?? '', 'attendance.approve')}
                canWriteSite={can(guard.role ?? '', 'site.write')}
                canConsumeStock={can(guard.role ?? '', 'stock.consume')}
              />

              <Card>
                <CardHeader>
                  <CardEyebrow>Clave de acceso</CardEyebrow>
                  <CardTitle as="h2">Abrir la obra y operar en ella son dos decisiones</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="text-muted-foreground">
                    Abrir la ficha exige <code className="font-mono text-xs">site.read</code> dentro
                    del subárbol de la membresía. Operar en ella —personal, asistencia, tablero,
                    equipos, stock, avance y bitácora— exige además una asignación activa, salvo para
                    los roles con alcance de organización.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="tabular w-full text-left text-[0.8125rem]">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th scope="col" className="py-2 pr-4 font-medium">
                            Rol
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium">
                            Mecanismo
                          </th>
                          <th scope="col" className="py-2 font-medium">
                            Con cero asignaciones activas
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...ORG_SCOPED_SITE_ROLES, ...ASSIGNMENT_SCOPED_ROLES].map((role) => {
                          const decision = resolveSiteAccess({
                            role,
                            siteId,
                            entityOrgNodeId: siteId,
                            scopeSubtree: [siteId],
                            assignedSiteIds: [],
                          });
                          const orgScoped = ORG_SCOPED_SITE_ROLES.includes(role);
                          return (
                            <tr key={role} className="border-b border-border/60 last:border-0">
                              <td className="py-2 pr-4">{roleLabel(role)}</td>
                              <td className="py-2 pr-4 text-muted-foreground">
                                {orgScoped ? 'subárbol de la organización' : 'asignación activa'}
                              </td>
                              <td className="py-2">
                                {decision.allow ? (
                                  <Badge variant="tinted">permitido</Badge>
                                ) : (
                                  <Badge variant="danger" className="font-mono">
                                    {decision.reason}
                                  </Badge>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    La columna «cero asignaciones activas» es la regla, no el estado de esta sesión:
                    el panel de personal es el que decide con la lista real de asignaciones que
                    devuelve <code className="font-mono text-xs">GET
                    /v1/obras/sites/:siteId/staff</code>. El subárbol se resuelve contra la membresía
                    en el API, y aquí se evalúa como si la obra estuviera dentro para poder aislar el
                    término de la asignación. Ninguna de estas comprobaciones sustituye al API: solo
                    evita ofrecer una acción que será denegada.
                  </p>
                </CardContent>
              </Card>

              <ScopeNote eyebrow="Regla de acceso" title="Trabajador fuera de obra no opera">
                <p>
                  El trabajador tiene <code className="font-mono text-xs">attendance.mark</code> y{' '}
                  <code className="font-mono text-xs">site.read</code>, nada más. Sin asignación
                  activa a esta obra, la ficha abre pero el marcado se resuelve como{' '}
                  <code className="font-mono text-xs">no_active_assignment</code>: la UI no ofrece la
                  acción y el API la rechaza con el mismo motivo.
                </p>
                <p>
                  Tampoco puede aprobar la asistencia de terceros:{' '}
                  <code className="font-mono text-xs">attendance.approve</code> no está en su matriz,
                  así que la aprobación ni siquiera se renderiza.
                </p>
              </ScopeNote>
            </div>
          );
        }}
      </RouteGuard>
    </div>
  );
}
