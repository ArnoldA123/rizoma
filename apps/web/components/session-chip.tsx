import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { IconLogOut, IconShieldCheck } from '@/components/ui/icons';
import { primaryRole } from '@/lib/tenant';
import { roleLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { CurrentSession } from '@/lib/session';

/**
 * Session chip — who is acting, under which tenant, and from where.
 *
 * Showing the *source* matters during W1: a session resolved from the local
 * development headers looks identical to a Keycloak one unless it says so, and
 * mistaking one for the other is exactly how a permission bug hides.
 */
export interface SessionChipProps {
  readonly session: CurrentSession;
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

export function SessionChip({ session }: SessionChipProps) {
  const { identity } = session;

  if (!identity.ok) {
    return (
      <div className="flex items-center gap-2">
        <Link href="/login" className={cn(buttonVariants({ variant: 'primary', size: 'sm' }))}>
          Entre aquí
        </Link>
      </div>
    );
  }

  const role = primaryRole(identity.identity);

  return (
    <div className="flex items-center gap-2.5">
      <div className="hidden flex-col items-end leading-tight sm:flex">
        <Badge variant={session.usingDevFallback ? 'outline' : 'tinted'}>
          {session.usingDevFallback ? 'Identidad local' : 'Keycloak'}
        </Badge>
        <span className="tabular text-[0.6875rem] text-muted-foreground">
          tenant {shortId(identity.identity.tenantId)} · {shortId(identity.identity.userId)}
        </span>
      </div>
      <Badge variant="accent">{roleLabel(role)}</Badge>
      <Link
        href="/api/auth/logout"
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        title="Cerrar sesión"
      >
        <IconLogOut />
        <span className="hidden sm:inline">Salir</span>
      </Link>
    </div>
  );
}

/** Compact reminder of the guard in force, used by the shell footer. */
export function GuardNote() {
  return (
    <p className="tabular flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
      <IconShieldCheck className="h-3.5 w-3.5" />
      Decisión final en el API · envelope {'{code, reason, traceId}'}
    </p>
  );
}
