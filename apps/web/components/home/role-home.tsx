import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { RouteIcon } from '@/components/route-icon';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconArrowRight } from '@/components/ui/icons';
import { CajaDay } from './caja-day';
import { MedicoDay } from './medico-day';
import { RecepcionDay } from './recepcion-day';

/**
 * One screen the session role may open: path plus the human copy the
 * navigation registry already gives it. The shell carries no stage badges
 * and no permission matrix — P3-2 removes those from the legacy home.
 */
export interface HomeLink {
  readonly path: string;
  readonly label: string;
  readonly description: string;
}

export interface RoleHomeProps {
  readonly role: string | null;
  readonly viewerId: string | null;
  readonly links: readonly HomeLink[];
}

/**
 * Home shell by session role (P3-1a).
 *
 * Salud roles get their own day cover with real data; every other role falls
 * through to a neutral temporary summary with links to its enabled screens
 * until P3-1b covers obras and auditoría. Rendered from the session branch
 * of `app/page.tsx`; the no-session branch stays untouched (P1).
 */
export function RoleHome({ role, viewerId, links }: RoleHomeProps) {
  if (role === 'medico') return <MedicoDay viewerId={viewerId} links={links} />;
  if (role === 'recepcion') return <RecepcionDay links={links} />;
  if (role === 'caja') return <CajaDay links={links} />;
  return <NeutralDay links={links} />;
}

/** Temporary cover for roles without their own day yet (P3-1b owns it). */
function NeutralDay({ links }: { readonly links: readonly HomeLink[] }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Inicio · hoy (UTC)"
        title="Tu día"
        description="Resumen temporal mientras cada rol recibe su portada. Sus pantallas habilitadas están abajo, con el mismo acceso de siempre."
      />
      <EnabledScreens links={links} />
    </div>
  );
}

/**
 * Link list to the enabled screens of the role: label plus description, no
 * stage badge, no matrix. Each day cover renders it below its own summary —
 * the small duplication across covers is deliberate, mirroring the CopyDetail
 * pattern, so every cover stays self-contained inside its own file.
 */
export function EnabledScreens({ links }: { readonly links: readonly HomeLink[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Pantallas habilitadas para su rol</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {links.length === 0 ? (
          <p className="text-muted-foreground">
            Su rol no habilita ninguna pantalla del alcance actual. Si necesita acceso, avise a
            jefatura o a soporte.
          </p>
        ) : (
          links.map((link) => (
            <Link
              key={link.path}
              href={link.path}
              className="group flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3 transition-colors hover:bg-secondary"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-accent-tint text-accent"
                >
                  <RouteIcon path={link.path} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{link.label}</span>
                  <span className="text-xs text-muted-foreground">{link.description}</span>
                </span>
              </span>
              <IconArrowRight className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  );
}
