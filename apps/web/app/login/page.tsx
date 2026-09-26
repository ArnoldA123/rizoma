import Link from 'next/link';
import { SessionChip } from '@/components/session-chip';
import { buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { IconAlertTriangle, IconArrowRight } from '@/components/ui/icons';
import { sanitizeNextPath } from '@/lib/navigation';
import { currentSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Login screen.
 *
 * It renders the session state it already has (so a logged-in user sees the
 * way back instead of a pointless button) and shows a single plain-language
 * error when the callback reports a failure. Technical detail travels only
 * inside the collapsed detail, never in the visible body.
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, session] = await Promise.all([searchParams, currentSession()]);
  const nextPath = sanitizeNextPath(typeof params.next === 'string' ? params.next : undefined);
  const errorCode = typeof params.error === 'string' ? params.error : undefined;
  const loginHref = `/api/auth/login${nextPath === '/' ? '' : `?next=${encodeURIComponent(nextPath)}`}`;

  return (
    <div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card tone="accent">
        <CardHeader>
          <CardTitle as="h1" className="text-lg">
            Iniciar sesión con Keycloak
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground">
            El ingreso se resuelve en el servidor. Pulse el botón para continuar.
          </p>

          {errorCode === undefined ? null : (
            <Alert
              variant="denied"
              icon={<IconAlertTriangle className="mt-0.5 h-4 w-4 text-danger" />}
              title="El inicio de sesión no se completó"
            >
              <p>No pudimos entrar. Reintenta o avisa a soporte.</p>
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                  Copiar detalle
                </summary>
                <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                  {errorCode}
                </pre>
              </details>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={loginHref}
              className={cn(buttonVariants({ variant: 'accent', size: 'md' }))}
            >
              Entrar con Keycloak
              <IconArrowRight />
            </Link>
            {session.identity.ok ? (
              <Link href="/" className={cn(buttonVariants({ variant: 'ghost', size: 'md' }))}>
                Volver al inicio
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardEyebrow>Estado actual</CardEyebrow>
            <CardTitle as="h2">Sesión</CardTitle>
          </CardHeader>
          <CardContent>
            <SessionChip session={session} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
