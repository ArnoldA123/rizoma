import '../obras.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { CompanyBoardPanel } from '@/components/obras/company-board';

/**
 * `/obras/tablero` — the company board (W4).
 *
 * The route requires `site.read`: the endpoint aggregates the caller's subtree
 * and every construction role that can open the vertical holds that action. The
 * board is *not* filtered by assignment — it is a company view, which is exactly
 * why it lives on its own route instead of inside a ficha.
 *
 * It is registered in `APP_ROUTES` before `/obras/[siteId]` so the static
 * segment wins in `matchRoute`: a dynamic `[siteId]` would otherwise capture
 * `tablero` and hand the board's URL to the ficha. Next's own file routing
 * already prefers the static segment; the registry order makes the two agree.
 */
export const dynamic = 'force-dynamic';

export default function ObrasBoardPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Obras · tablero"
        title="Tablero de empresa"
        description="Obras y avance agregado del subárbol de la membresía, con lectura automática de 5 a 15 minutos y caché de cliente."
        badges={['obras']}
      />

      <RouteGuard path="/obras/tablero">
        {() => <CompanyBoardPanel />}
      </RouteGuard>

      <ScopeNote eyebrow="Contrato del tablero" title="Un cero y una ausencia de dato no son lo mismo">
        <p>
          <code className="font-mono text-xs">GET /v1/obras/board</code> no acepta sede: agrega todo
          el subárbol de la membresía y devuelve el nodo que usó, así que la pantalla no inventa un
          campo que el endpoint no tiene. La cobranza y el uso por módulo no existen en MVP1 y el API
          los declara como no aplicables en lugar de reportarlos como cero.
        </p>
        <p>
          MVP1 no tiene réplica de lectura ni caché Redis: la pantalla consulta la conexión de la
          solicitud y refresca dentro de la banda de 5 a 15 minutos de obras, con una caché de
          cliente de un minuto por <code className="font-mono text-xs">nodo|día</code>. El temporizador
          se detiene mientras la pestaña está oculta y refresca una vez al volver.
        </p>
      </ScopeNote>
    </div>
  );
}
