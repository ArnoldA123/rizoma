import '../salud.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { ScopeNote } from '@/components/scope-note';
import { CajaBoard } from '@/components/salud/caja-board';

/**
 * `/salud/caja` — the billing screen of W3.
 *
 * The other half of the clinical/billing separation: the screen requires
 * `invoice.issue`, which only `caja` holds, and the caja board contract carries
 * amounts and fiscal states only. Together with `/salud/agenda` this closes the
 * pair "caja nunca ve clínica, médico nunca ve importes" at the UI level.
 *
 * The page itself is a server component and only resolves the role: every
 * capability decision travels to the client as a value, and the browser receives
 * a decision instead of a rule to re-evaluate.
 */
export const dynamic = 'force-dynamic';

export default function SaludCajaPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Salud · caja"
        title="Caja"
        description="Turno de caja, cotizaciones, emisión y cobro de comprobantes, y estado fiscal de cada documento."
        badges={['W3', 'salud']}
      />

      <RouteGuard path="/salud/caja">
        {(guard) => <CajaBoard role={guard.role} />}
      </RouteGuard>

      <ScopeNote eyebrow="Regla de acceso" title="Médico nunca ve importes">
        <p>
          La ruta exige <code className="font-mono text-xs">invoice.issue</code>, que solo tiene caja.
          Médico y recepción reciben la denegación con motivo{' '}
          <code className="font-mono text-xs">role.denied</code> antes de que exista una sola llamada
          a facturación.
        </p>
        <p>
          En la dirección contraria, el contrato de facturación no declara ningún campo clínico: el
          comprobante nombra un cliente, un documento, importes y un estado fiscal. El esquema de{' '}
          <code className="font-mono text-xs">@rizoma/contracts</code> descarta cualquier campo
          clínico que llegue de más, y esta pantalla no tiene ninguna ruta hacia una ficha de
          paciente.
        </p>
        <p>
          El IGV no se recalcula en el cliente: la regla de redondeo por línea vive en el servicio del
          API, y aquí solo se formatea el resultado. El saldo pendiente es la resta de los cobros
          registrados, la misma operación con la que el API rechaza un pago en exceso.
        </p>
      </ScopeNote>
    </div>
  );
}
