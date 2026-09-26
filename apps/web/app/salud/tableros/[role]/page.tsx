import '../../salud.css';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { Alert } from '@/components/ui/alert';
import { IconLock } from '@/components/ui/icons';
import { RoleBoard } from '@/components/salud/role-board';
import { boardRoleFor } from '@rizoma/contracts';
import { boardRoleLabel, roleLabel } from '@/lib/labels';

/**
 * `/salud/tableros/[role]` — one role board (W3).
 *
 * Two rules decide whether a board is rendered, and both mirror the API:
 *
 *   1. the route requires `agenda.read` or `invoice.issue` (`RouteGuard`), which
 *      is what makes the recepción/médico boards and the caja board reachable
 *      without over-granting either action;
 *   2. the caller's role must *be* the board role — the service evaluates
 *      `rolePermits = role === membership.role`, so any other combination is a
 *      403 `role.denied`. `boardRoleFor` is the same rule on the client side, and
 *      a mismatch renders the denial instead of issuing a call that would fail.
 *
 * An unknown role segment is a 404: the URL names a board the API does not have.
 */
export const dynamic = 'force-dynamic';

export default async function SaludBoardPage({
  params,
}: {
  params: Promise<{ readonly role: string }>;
}) {
  const { role } = await params;
  const boardRole = boardRoleFor(role);
  if (boardRole === null) notFound();

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Salud · tableros"
        title={`Tablero de ${boardRoleLabel(boardRole)}`}
        description="KPIs del día por rol, con lectura automática dentro de la banda de 1 a 5 minutos y caché de cliente."
        badges={['W3', 'salud', boardRole]}
      />

      <RouteGuard path="/salud/tableros/[role]">
        {(guard) =>
          guard.role === boardRole ? (
            <RoleBoard role={boardRole} />
          ) : (
            <Alert
              variant="denied"
              icon={<IconLock className="mt-0.5 h-4 w-4 text-danger" />}
              title="Tablero de otro rol"
            >
              <p>
                El tablero de {boardRoleLabel(boardRole)} solo lo abre quien tiene ese rol. El rol
                activo es {roleLabel(guard.role)}, por eso esta pantalla no muestra datos ni envía
                la solicitud. Vuelva al tablero de su rol. Si necesita este acceso, avise a
                jefatura o a soporte.
              </p>
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                  Copiar detalle
                </summary>
                <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">code</dt>
                  <dd className="font-mono break-all">access.denied</dd>
                  <dt className="text-muted-foreground">reason</dt>
                  <dd className="font-mono break-all">role.denied</dd>
                  <dt className="text-muted-foreground">status</dt>
                  <dd className="font-mono break-all">403</dd>
                  <dt className="text-muted-foreground">traceId</dt>
                  <dd className="font-mono break-all">{guard.traceId}</dd>
                </dl>
              </details>
            </Alert>
          )
        }
      </RouteGuard>

      <ScopeNote eyebrow="Contrato del tablero" title="Caja sin clínica, médico sin importes">
        <p>
          Los tableros de salud son tres contratos separados, no tres vistas del mismo objeto: el de
          caja transporta importes y estados fiscales, el de recepción conteos de agenda y el clínico
          conteos propios. Los esquemas de <code className="font-mono text-xs">@rizoma/contracts</code>{' '}
          descartan cualquier campo que no declaren, y las pruebas negativas de contrato lo verifican.
        </p>
        <p>
          La sede se lee del parámetro <code className="font-mono text-xs">?org=</code> y debe estar
          dentro del subárbol de la membresía; el día es UTC y se omite para pedir el día de hoy.
        </p>
        <p>
          MVP1 no tiene réplica de lectura ni caché Redis: la pantalla consulta la conexión de la
          solicitud y refresca dentro de la banda de 1 a 5 minutos, con una caché de cliente de un
          minuto por <code className="font-mono text-xs">rol|sede|día</code>.
        </p>
      </ScopeNote>
    </div>
  );
}
