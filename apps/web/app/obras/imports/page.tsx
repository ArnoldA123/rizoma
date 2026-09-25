import '../obras.css';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { ObrasImportsPanel } from '@/components/obras/imports-panel';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { can } from '@/lib/navigation';

/**
 * `/obras/imports` — workers and equipment CSVs (W5).
 *
 * The route requires *any* of `assignment.write` / `site.write`, because the two
 * importers are not gated on the same action: `POST /v1/obras/imports/workers`
 * creates users with a membership (`assignment.write`), while
 * `POST /v1/obras/imports/assets` creates catalogue units (`site.write`). The
 * page therefore resolves both capabilities and hands them to the panel, which
 * offers exactly the loads the caller may run — the route gate alone would either
 * deny jefatura de obra a legitimate load or advertise one the API refuses.
 */
export const dynamic = 'force-dynamic';

export default function ObrasImportsPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Obras · importaciones"
        title="Importar trabajadores y equipos"
        description="Carga por CSV con resumen del job, filas rechazadas descargables y clave de repetición por hash del archivo."
        badges={['W5', 'obras']}
      />

      <RouteGuard path="/obras/imports">
        {(guard) => (
          <div className="flex flex-col gap-5">
            <ObrasImportsPanel
              canImportWorkers={can(guard.role ?? '', 'assignment.write')}
              canImportAssets={can(guard.role ?? '', 'site.write')}
            />

            <Card>
              <CardHeader>
                <CardEyebrow>Volver</CardEyebrow>
                <CardTitle as="h2">Los jobs se consultan por identificador</CardTitle>
                <CardDescription>
                  MVP1 no expone un listado de importaciones: el identificador del job es la vía de
                  auditoría de una carga anterior, y el detalle devuelve los contadores junto con el
                  CSV de errores.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/obras" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  Volver a obras
                </Link>
              </CardContent>
            </Card>
          </div>
        )}
      </RouteGuard>

      <ScopeNote eyebrow="Contrato de la carga" title="Idempotente por hash del archivo">
        <p>
          El API deriva su clave de repetición del SHA-256 del CSV (§5.4) y la pantalla envía ese
          mismo digest como <code className="font-mono text-xs">Idempotency-Key</code>: volver a subir
          los mismos bytes responde el job original, con su CSV de errores, en lugar de importar dos
          veces. Los mismos bytes apuntados a otra sede son un 409, porque es otra intención de carga
          y no un reintento.
        </p>
        <p>
          Cada fila se inserta dentro de su propio SAVEPOINT, así que una fila inválida se cuenta como
          error y no aborta el archivo. Además del hash, los dos importadores son idempotentes por
          clave de negocio: un correo ya existente entre los trabajadores y un código de equipo ya
          registrado se reportan como fila rechazada en lugar de duplicar la fila.
        </p>
        <p>
          El CSV viaja como texto en el cuerpo de la solicitud, no como archivo adjunto: MVP1 no
          expone endpoints de archivos, y el CSV de errores se entrega al navegador desde el detalle
          del job a través del proxy, que es el único camino que transporta{' '}
          <code className="font-mono text-xs">content-disposition</code>.
        </p>
      </ScopeNote>
    </div>
  );
}
