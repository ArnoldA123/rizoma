import Link from 'next/link';
import { ApiStatusCard } from '@/components/api-status-card';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { SessionRequiredNotice } from '@/components/session-required-notice';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { IconArrowRight } from '@/components/ui/icons';
import { ACTION_CODES, newTraceId, rolePermitsAction } from '@/lib/access';
import { ACTION_LABELS, roleLabel } from '@/lib/labels';
import { navItemsFor } from '@/lib/navigation';
import { currentSession } from '@/lib/session';
import { primaryRole } from '@/lib/tenant';

/**
 * Home — the W1 landing screen.
 *
 * It does three jobs and no more: it proves the session and tenant are resolved
 * (with their source), it proves the API is reachable, and it shows exactly
 * which sections and actions the role holds. The capability list is the visible
 * form of the guard mirror, which is what makes "caja nunca ve clínica"
 * checkable by looking at the screen rather than reading the code.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await currentSession();

  if (!session.identity.ok) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="MVP1 · base web + autenticación + contratos"
          title="Rizoma"
          description="La identidad y el tenant se resuelven antes de cualquier decisión de acceso."
        />
        <SessionRequiredNotice
          code={session.identity.code}
          reason={session.identity.reason}
          message={session.identity.message}
          traceId={newTraceId()}
        />
      </div>
    );
  }

  const identity = session.identity.identity;
  const role = primaryRole(identity);
  const reachable = navItemsFor(role ?? '').filter((route) => route.path !== '/');
  const grantedActions = ACTION_CODES.filter((action) => rolePermitsAction(role ?? '', action));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="MVP1 · base web + autenticación + contratos"
        title={`Sesión de ${roleLabel(role)}`}
        description="El contexto de tenant sale del token (claim tenant_id, con azp como respaldo) o, solo en desarrollo, de las cabeceras locales. El API sigue siendo la autoridad de cada decisión."
        badges={[
          session.usingDevFallback ? 'identidad local de desarrollo' : 'sesión Keycloak',
          `tenant ${identity.tenantId.slice(0, 8)}…`,
          `usuario ${identity.userId.slice(0, 8)}…`,
        ]}
      />

      <ApiStatusCard />

      <section className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardEyebrow>Accesos</CardEyebrow>
            <CardTitle as="h2">Pantallas habilitadas para su rol</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {reachable.length === 0 ? (
              <p className="text-muted-foreground">
                El rol {roleLabel(role)} no habilita ninguna pantalla del MVP1. El matiz es
                deliberado: la matriz de permisos no otorga nada a este rol en el alcance web.
              </p>
            ) : (
              reachable.map((route) => (
                <Link
                  key={route.path}
                  href={route.path}
                  className="group flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3 transition-colors hover:bg-secondary"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-accent-tint text-accent"
                    >
                      <RouteIcon path={route.path} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">{route.label}</span>
                      <span className="text-xs text-muted-foreground">{route.description}</span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">{route.stage}</Badge>
                    <IconArrowRight className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardEyebrow>Guarda de interfaz</CardEyebrow>
            <CardTitle as="h2">Acciones efectivas del rol</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-muted-foreground">
              Espejo de <code className="font-mono text-xs">auth/policy.ts</code> y{' '}
              <code className="font-mono text-xs">auth/guard.ts</code>. Denegación por defecto:
              cualquier acción ausente no se ofrece y, si se fuerza, el API responde 403 con{' '}
              <code className="font-mono text-xs">access.denied</code>.
            </p>
            <div className="flex flex-wrap gap-2">
              {ACTION_CODES.map((action) => {
                const granted = grantedActions.includes(action);
                return (
                  <Badge
                    key={action}
                    variant={granted ? 'tinted' : 'outline'}
                    className={granted ? undefined : 'opacity-60 line-through'}
                    title={action}
                  >
                    {ACTION_LABELS[action]}
                  </Badge>
                );
              })}
            </div>
            <p className="tabular text-xs text-muted-foreground">
              {grantedActions.length} de {ACTION_CODES.length} acciones · rol{' '}
              {role === null ? 'sin resolver' : roleLabel(role)}
            </p>
          </CardContent>
        </Card>
      </section>

      <Card tone="tinted">
        <CardHeader>
          <CardEyebrow>Contratos</CardEyebrow>
          <CardTitle as="h2">Capa de tipos compartida</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-muted-foreground">
          <p>
            Las respuestas del API se validan con los esquemas Zod de{' '}
            <code className="font-mono text-xs">@rizoma/contracts</code> antes de llegar a la
            pantalla: fichas, episodios, citas, consentimientos, facturación, obras y tableros.
          </p>
          <p>
            Una forma inesperada falla en el borde con{' '}
            <code className="font-mono text-xs">api.contract_mismatch</code> en lugar de propagarse
            como datos incompletos hacia la interfaz.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
