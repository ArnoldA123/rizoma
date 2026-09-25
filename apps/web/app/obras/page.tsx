import './obras.css';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { SitesBrowser } from '@/components/obras/sites-browser';
import { can } from '@/lib/navigation';
import { DEV_IDENTITY } from '@/lib/config';

/**
 * `/obras` — the site list and the registration form (W4), plus the entry points
 * of the W5 operation surfaces.
 *
 * The route requires `site.read`, which every construction role holds; what
 * differs per role is *which* sites come back, and that is decided by the org
 * subtree in the API, not by this screen. The alta is gated separately on
 * `site.write`, which in the matrix only gerencia has, so the form is not even
 * rendered for a read-only role.
 *
 * The W5 half (equipos, stock, avance y bitácora) lives inside a ficha, under the
 * assignment key of that obra, so this screen links to it through the site it
 * registers or lists instead of duplicating the panels. The CSV importers get
 * their own route because they are a company-scope load, not a site one.
 */
export const dynamic = 'force-dynamic';

export default function ObrasPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Obras"
        title="Obras"
        description="Obras del alcance, personal asignado, asistencia, operación, importaciones y tableros de obra y de empresa."
        badges={['W4-W5', 'obras']}
      />

      <RouteGuard path="/obras">
        {(guard) => (
          <div className="flex flex-col gap-5">
            <SitesBrowser
              role={guard.role}
              canWrite={can(guard.role ?? '', 'site.write')}
              defaultOrgNodeId={DEV_IDENTITY.orgNodeId}
            />

            <Card>
              <CardHeader>
                <CardEyebrow>Tableros</CardEyebrow>
                <CardTitle as="h2">Tablero de empresa</CardTitle>
                <CardDescription>
                  Obras y avance agregado del subárbol de la membresía, con lectura automática de 5
                  a 15 minutos. El tablero de una obra concreta vive en su ficha, con la misma
                  clave de acceso que el personal y la asistencia.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/obras/tablero" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Abrir tablero de empresa
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardEyebrow>Importaciones</CardEyebrow>
                <CardTitle as="h2">Trabajadores y equipos por CSV</CardTitle>
                <CardDescription>
                  Los dos importadores comparten forma: el CSV viaja como texto con la sede, cada fila
                  se inserta en su propio SAVEPOINT y la clave de repetición es el SHA-256 del
                  archivo. Importar trabajadores exige poder asignar personal; importar equipos, poder
                  escribir el catálogo de obras.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/obras/imports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Abrir importaciones
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardEyebrow>Operación de obra</CardEyebrow>
                <CardTitle as="h2">Equipos, stock, avance y bitácora</CardTitle>
                <CardDescription>
                  La operación vive dentro de cada ficha, detrás de la clave de acceso de esa obra:
                  asignar equipos, contabilizar consumo de almacén, registrar partidas y publicar la
                  bitácora. Este listado es la puerta de entrada; el tablero de cada obra enlaza
                  además cada pendiente con el panel que lo resuelve.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Link href="/obras/tablero" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  Ver tablero de empresa
                </Link>
                <span className="text-xs text-muted-foreground">
                  Abra una obra para operar en ella.
                </span>
              </CardContent>
            </Card>

            <ScopeNote eyebrow="Regla de acceso" title="Jefe de obra solo ve sus obras">
              <p>
                La clave de acceso de esta vertical es la organización más la asignación, no el rol
                aislado. Gerencia y jefatura de obra pertenecen al conjunto con alcance de
                organización, así que alcanzan cualquier obra de su subárbol; el resto de roles de
                construcción necesita una asignación activa y no la obtienen por el rol.
              </p>
              <p>
                El listado devuelve solo las obras del subárbol de la membresía. Un rol con{' '}
                <code className="font-mono text-xs">site.read</code> pero fuera del subárbol recibe{' '}
                <code className="font-mono text-xs">scope.outside_subtree</code>; uno dentro del
                subárbol sin asignación activa recibe{' '}
                <code className="font-mono text-xs">no_active_assignment</code> al intentar operar
                dentro de la ficha.
              </p>
            </ScopeNote>
          </div>
        )}
      </RouteGuard>
    </div>
  );
}
