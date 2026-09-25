import '../salud.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { PatientsBrowser } from '@/components/salud/patients-browser';
import { can } from '@/lib/navigation';

/**
 * `/salud/pacientes` — patient list and registration (W2).
 *
 * The route rule is `any(patient.read, patient.write)` because one screen hosts
 * two capabilities, and the page keeps them separate instead of over-granting
 * either: `patient.read` gates the list, `patient.write` gates the form. That is
 * what lets reception register a file without ever being shown the list it is not
 * allowed to read, and it mirrors the API exactly (`GET /v1/salud/patients`
 * answers 403 `role.denied` for reception while the `POST` proceeds).
 *
 * The capability decisions are resolved here, on the server, with the guard
 * mirror (`can`), and travel to the client component as booleans: the browser
 * receives a decision, not a rule to re-evaluate.
 */
export const dynamic = 'force-dynamic';

export default function SaludPacientesPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Salud · ficha 360"
        title="Pacientes"
        description="Registro con validación en vivo y lista paginada en el cliente. La ficha 360 abre consentimientos, episodios y citas, y deja la cuenta como enlace a caja."
        badges={['W2', 'salud']}
      />

      <RouteGuard path="/salud/pacientes">
        {(guard) => (
          <PatientsBrowser
            role={guard.role}
            canRead={can(guard.role ?? '', 'patient.read')}
            canWrite={can(guard.role ?? '', 'patient.write')}
          />
        )}
      </RouteGuard>
    </div>
  );
}
