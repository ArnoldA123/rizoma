import { PageHeader } from '@/components/page-header';
import { ScopeNote } from '@/components/scope-note';
import { OnboardingWizard } from '@/components/onboarding/wizard';

/**
 * `/onboarding` — the first-run setup wizard (H3).
 *
 * Public on purpose: the run happens before any tenant exists (pre-tenant
 * setup, migration 002), so there is no session to guard with — the page
 * renders no `RouteGuard` and the wizard calls the setup API directly. The
 * registry entry carries no actions (open route) and stays out of the
 * navigation (`navHidden`): the first run is a setup destination, not a daily
 * screen, and the pinned nav tests pin the per-role lists.
 */
export const dynamic = 'force-dynamic';

export default function OnboardingPage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Arranque · alta inicial"
        title="Onboarding"
        description="Asistente de primer arranque en siete pasos: organización, sedes, identidad, facturación, administración, revisión y firma del acta."
        badges={['setup']}
      />

      <OnboardingWizard />

      <ScopeNote eyebrow="Rol de setup" title="Anterior a cualquier tenant">
        <p>
          Esta pantalla no exige sesión ni tenant: el alta corre antes de que exista el tenant, con
          el rol de setup sobre <code className="font-mono text-xs">onboarding_cases</code> y{' '}
          <code className="font-mono text-xs">app_state</code> (migración 002, sin RLS por ser datos
          pre-tenant). La protección multi-tenant empieza en{' '}
          <code className="font-mono text-xs">onboarding_acta</code>.
        </p>
        <p>
          Cada paso confirmado persiste en el caso y el último firma el acta con su hash SHA-256:
          el alta corre una sola vez y no se reabre.
        </p>
      </ScopeNote>
    </div>
  );
}
