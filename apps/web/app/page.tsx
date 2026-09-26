import Link from 'next/link';
import { ApiStatusCard } from '@/components/api-status-card';
import { RoleHome } from '@/components/home/role-home';
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
 * It does three jobs and no more: it confirms the session is active, it shows
 * whether the service answers, and it shows exactly which sections and actions
 * the role holds. Machine facts (ids, claims, codes, file paths) live only
 * inside a collapsed detail, never in the visible body. The per-role day covers
 * for salud (médico, recepción, caja) live in `components/home/role-home` (P3-1a)
 * and this screen delegates to them; every other role keeps the current
 * structure below on purpose until P3-2 removes the infra cards.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await currentSession();

  if (!session.identity.ok) {
    return (
      <div className="flex flex-col gap-8">
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

  // P3-1a: salud roles get their day cover; every other role keeps the legacy
  // home below until P3-2 removes the infra cards. The no-session branch above
  // stays untouched (P1).
  if (role === 'medico' || role === 'recepcion' || role === 'caja') {
    const links = navItemsFor(role ?? '')
      .filter((route) => route.path !== '/')
      .map((route) => ({
        path: route.path,
        label: route.label,
        description: route.description,
      }));
    return (
      <div className="flex flex-col gap-8">
        <RoleHome role={role} viewerId={identity.userId} links={links} />
      </div>
    );
  }

  const reachable = navItemsFor(role ?? '').filter((route) => route.path !== '/');
  const grantedActions = ACTION_CODES.filter((action) => rolePermitsAction(role ?? '', action));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="MVP1 · base web + autenticación + contratos"
        title={`Sesión de ${roleLabel(role)}`}
        description="Su sesión está activa y el servicio ya verificó su acceso. Aquí ve las pantallas y acciones que permite su rol."
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
              Solo ve lo que su rol permite. Si falta una acción, no se ofrece; si se fuerza,
              el servicio la deniega.
            </p>
            <div className="flex flex-wrap gap-2">
              {ACTION_CODES.map((action) => {
                const granted = grantedActions.includes(action);
                return (
                  <Badge
                    key={action}
                    variant={granted ? 'tinted' : 'outline'}
                    className={granted ? undefined : 'opacity-60 line-through'}
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
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                Copiar detalle
              </summary>
              <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                {`auth/policy.ts · auth/guard.ts\naccess.denied`}
              </pre>
            </details>
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
            Los datos se verifican antes de mostrarse en pantalla. Si algo llega incompleto,
            se avisa en lugar de mostrar datos a medias.
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer underline underline-offset-2">
              Copiar detalle
            </summary>
            <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
              {`@rizoma/contracts (zod)\napi.contract_mismatch`}
            </pre>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
