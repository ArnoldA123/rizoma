import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { IconLogOut } from '@/components/ui/icons';
import { primaryRole } from '@/lib/tenant';
import { roleLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { CurrentSession } from '@/lib/session';

/**
 * Session chip — who is acting and how to leave.
 *
 * The visible chip shows only the role name and the exit action: tenant and
 * user ids, identity source and envelope fields never render here. There is
 * currently no display-name or site source on the identity, so the chip does
 * not invent them — name + site belong to the P3 header once a source exists.
 */
export interface SessionChipProps {
  readonly session: CurrentSession;
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
      <span className="hidden text-sm text-muted-foreground sm:inline">Sesión activa</span>
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
