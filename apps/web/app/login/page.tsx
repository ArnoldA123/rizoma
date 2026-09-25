import Link from 'next/link';
import { SessionChip } from '@/components/session-chip';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { IconAlertTriangle, IconArrowRight, IconShieldCheck } from '@/components/ui/icons';
import { DEV_IDENTITY } from '@/lib/config';
import { sanitizeNextPath } from '@/lib/navigation';
import { OIDC_REDIRECT_URI, WEB_ORIGIN } from '@/lib/server-config';
import { currentSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Login screen.
 *
 * It renders the session state it already has (so a logged-in user sees "you
 * are already in" instead of a pointless button), translates the OIDC failure
 * codes the callback writes into the URL, and documents the one piece of
 * Keycloak configuration the flow depends on: the whitelisted redirect URI.
 */
export const dynamic = 'force-dynamic';

/** Failure codes `/api/auth/callback` can set, with operator-facing copy. */
const ERROR_COPY: Record<string, string> = {
  'oidc.realm_rejected':
    'El realm rechazó la solicitud de autorización (cliente deshabilitado o redirect_uri no autorizada).',
  'oidc.flow_missing':
    'Se perdió el estado del flujo: la cookie temporal venció o el inicio de sesión se abrió en otra pestaña.',
  'oidc.state_mismatch':
    'El parámetro state no coincide con el del flujo iniciado; la respuesta se descartó como medida de seguridad.',
  'oidc.exchange_failed':
    'No se pudo canjear el código por tokens. Revise que el reloj del host y el del realm coincidan y que el cliente sea público con PKCE S256.',
};

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
          <CardEyebrow>MVP1 · acceso</CardEyebrow>
          <CardTitle as="h1" className="text-lg">
            Iniciar sesión con Keycloak
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground">
            El flujo es Authorization Code con PKCE (S256) resuelto en el servidor: el código se
            canjea en un Route Handler y el token queda en una cookie <code>HttpOnly</code>. El
            navegador nunca ve el token de acceso, así que el API no necesita CORS y el cliente
            Keycloak no necesita secreto.
          </p>

          {errorCode === undefined ? null : (
            <Alert
              variant="denied"
              icon={<IconAlertTriangle className="mt-0.5 h-4 w-4 text-danger" />}
              title="El inicio de sesión no se completó"
            >
              <p>{ERROR_COPY[errorCode] ?? 'Falló el flujo de autenticación.'}</p>
              <p className="tabular mt-2 font-mono text-xs">{errorCode}</p>
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
            <Link href="/" className={cn(buttonVariants({ variant: 'ghost', size: 'md' }))}>
              Volver al inicio
            </Link>
          </div>

          <p className="text-xs text-muted-foreground">
            El primer acceso de un usuario de demostración pide configurar TOTP: los usuarios del
            realm traen la acción requerida <code>CONFIGURE_TOTP</code>.
          </p>
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

        <Card>
          <CardHeader>
            <CardEyebrow>Configuración del realm</CardEyebrow>
            <CardTitle as="h2" className="flex items-center gap-2">
              <IconShieldCheck className="text-accent" />
              Cliente público con PKCE
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
            <p>
              <span className="text-foreground">redirect_uri autorizada</span>
              <br />
              <code className="tabular font-mono break-all">{OIDC_REDIRECT_URI}</code>
            </p>
            <p>
              <span className="text-foreground">origen del web</span>
              <br />
              <code className="tabular font-mono break-all">{WEB_ORIGIN}</code>
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge variant="outline">client rizoma-web</Badge>
              <Badge variant="outline">code + PKCE S256</Badge>
            </div>
          </CardContent>
        </Card>

        {DEV_IDENTITY.enabled ? (
          <Card tone="tinted">
            <CardHeader>
              <CardEyebrow>Desarrollo</CardEyebrow>
              <CardTitle as="h2">Identidad local habilitada</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
              <p>
                Con <code>NEXT_PUBLIC_ALLOW_DEV_HEADERS=true</code> el proxy acepta{' '}
                <code>x-tenant-id</code>, <code>x-user-id</code> y <code>x-scopes</code> cuando no
                hay sesión. El API los acepta solo fuera de producción, con el mismo criterio de
                UUID que el middleware.
              </p>
              <p className="tabular font-mono break-all">
                tenant {DEV_IDENTITY.tenantId === '' ? '(sin configurar)' : DEV_IDENTITY.tenantId}
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
