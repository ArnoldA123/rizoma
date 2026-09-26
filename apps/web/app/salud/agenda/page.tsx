import '../salud.css';
import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { AgendaBoard } from '@/components/salud/agenda-board';
import { can } from '@/lib/navigation';

/**
 * `/salud/agenda` — day agenda, per-role view and scheduling (W2).
 *
 * The route requires `agenda.read`, which is the same term the API applies to
 * `GET /v1/salud/appointments`. The negative case the stub documented is now the
 * real behaviour: `caja` holds `invoice.issue` and no `agenda.read`, so it never
 * reaches this page and the denial renders `code`, `reason` and `traceId` without
 * leaking an appointment.
 *
 * Two facts travel from the server because only the session knows them: the
 * resolved role (which selects the view) and the user id (which the physician
 * focus matches against `professional_id`).
 */
export const dynamic = 'force-dynamic';

export default function SaludAgendaPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Salud · agenda"
        title="Agenda"
        description="Citas del día en UTC, vista por rol, actualización automática cada dos minutos y programación con validación en vivo."
        badges={['salud']}
      />

      <RouteGuard path="/salud/agenda">
        {(guard) => (
          <AgendaBoard
            role={guard.role}
            viewerId={
              guard.session.identity.ok ? guard.session.identity.identity.userId : null
            }
            canWrite={can(guard.role ?? '', 'appointment.write')}
          />
        )}
      </RouteGuard>
    </div>
  );
}
