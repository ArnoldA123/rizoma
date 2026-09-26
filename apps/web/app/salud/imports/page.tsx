import '../salud.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { ImportsPanel } from '@/components/salud/imports-panel';

/**
 * `/salud/imports` — the patients CSV importer (W3).
 *
 * The route mirrors the action the endpoint enforces: the API gates
 * `POST /v1/salud/imports/patients` on `patient.write` (an import *writes*
 * patient files, it does not read them), so a role without that grant never sees
 * the screen and never issues a call it knows will fail.
 */
export const dynamic = 'force-dynamic';

export default function SaludImportsPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Salud · importaciones"
        title="Importar pacientes"
        description="Carga de un CSV de fichas con resumen del job y CSV de errores descargable."
        badges={['salud']}
      />

      <RouteGuard path="/salud/imports">
        {() => <ImportsPanel />}
      </RouteGuard>

      <ScopeNote eyebrow="Contrato de la carga" title="Idempotente por hash del archivo">
        <p>
          La clave de repetición del API es el SHA-256 del CSV (§5.4), y la pantalla envía ese mismo
          digest como <code className="font-mono text-xs">Idempotency-Key</code>: volver a subir los
          mismos bytes responde el job original, incluso desde otra sesión, en lugar de importar dos
          veces.
        </p>
        <p>
          Cada fila se inserta dentro de su propio SAVEPOINT, así que una fila inválida se cuenta como
          error y no aborta el archivo. Las filas aceptadas dejan el consentimiento informado inicial
          en estado pendiente.
        </p>
        <p>
          MVP1 no expone un endpoint de archivos: el CSV viaja como texto en el cuerpo de la
          solicitud, y el CSV de errores se entrega al navegador desde el detalle del job a través del
          proxy, que es el único camino que transporta{' '}
          <code className="font-mono text-xs">content-disposition</code>.
        </p>
      </ScopeNote>
    </div>
  );
}
