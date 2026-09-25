import Link from 'next/link';
import { RouteIcon } from '@/components/route-icon';
import { navItemsFor, type AppRoute } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/**
 * Section navigation. Server-rendered, filtered by the actions the current role
 * actually holds, so a screen the role can never reach is not advertised — a
 * denial is then a real event (deep link, revoked role) instead of the normal
 * way to discover the app.
 */
function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  if (href.includes('[')) {
    const prefix = href.slice(0, href.indexOf('['));
    return pathname.startsWith(prefix);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface AppNavProps {
  readonly role: string | null;
  readonly pathname: string;
}

export function AppNav({ role, pathname }: AppNavProps) {
  if (role === null) return null;
  const items: readonly AppRoute[] = navItemsFor(role).filter((route) => route.path !== '/');
  if (items.length === 0) return null;

  return (
    <nav aria-label="Secciones" className="flex items-center gap-1">
      {items.map((route) => {
        const active = isActive(route.path, pathname);
        return (
          <Link
            key={route.path}
            href={route.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[0.8125rem] font-medium transition-colors',
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <RouteIcon path={route.path} className="h-3.5 w-3.5" />
            {route.label}
          </Link>
        );
      })}
    </nav>
  );
}
