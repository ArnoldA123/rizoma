import '../../salud.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { PatientFile } from '@/components/salud/patient-file';
import { can } from '@/lib/navigation';

/**
 * `/salud/pacientes/[id]` — the ficha 360 (W2).
 *
 * The route requires `patient.read` in `all` mode: every panel below reads
 * something clinical (`GET /v1/salud/patients/:id`, `/consents`, `/episodes`,
 * `/appointments`), and all four endpoints enforce `patient.read`. A role that
 * only writes files (reception) therefore reaches this URL through a denial with
 * the same `reason` the API would return — the guard mirror, not a new rule.
 *
 * The per-capability flags are resolved server-side: `patient.write` for the
 * consent lifecycle, `episode.write` for opening and closing episodes, and
 * `invoice.issue` for the caja link, which is the only billing surface this
 * screen is allowed to point at.
 */
export const dynamic = 'force-dynamic';

export default async function SaludPatientFilePage({
  params,
}: {
  params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Salud · ficha 360"
        title="Ficha del paciente"
        description="Cabecera con alergias y alertas primero, consentimientos con su matriz de grabación, episodios con apertura y cierre, citas del paciente y la cuenta como enlace."
        badges={['salud']}
      />

      <RouteGuard path="/salud/pacientes/[id]">
        {(guard) => (
          <PatientFile
            patientId={id}
            role={guard.role}
            canWrite={can(guard.role ?? '', 'patient.write')}
            canEpisodeWrite={can(guard.role ?? '', 'episode.write')}
            canInvoice={can(guard.role ?? '', 'invoice.issue')}
          />
        )}
      </RouteGuard>
    </div>
  );
}
