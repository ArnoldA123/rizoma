import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppNav } from '@/components/app-nav';
import { DisplayControls } from '@/components/display-controls';
import { SessionChip } from '@/components/session-chip';
import type { AppRoute, SkinId } from '@/lib/navigation';
import { SECTION_LABELS } from '@/lib/labels';
import { primaryRole } from '@/lib/tenant';
import type { CurrentSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Application shell — the neutral chrome every screen shares.
 *
 * The skin (`data-skin`) is applied here, once, so `salud` and `obras` recolour
 * the accent slot without touching a single component: the wrapper carries the
 * attribute, the tokens do the rest. The decorative grid is a fixed layer
 * behind the content, drawn only from `--base-line`, and is switched off with
 * `data-grid="off"` — no asset, no extra request, dark-mode aware.
 */
export interface AppShellProps {
  readonly skin: SkinId;
  readonly pathname: string;
  readonly route: AppRoute | null;
  readonly session: CurrentSession;
  readonly children: ReactNode;
}

export function AppShell({ skin, pathname, route, session, children }: AppShellProps) {
  const role = session.identity.ok ? primaryRole(session.identity.identity) : null;
  const sectionLabel = SECTION_LABELS[route?.section ?? 'inicio'];

  return (
    <div data-skin={skin} className="relative flex min-h-dvh flex-col">
      <div
        aria-hidden
        className="bg-grid bg-grid-fade pointer-events-none fixed inset-0 -z-10"
      />

      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-5 py-3">
          <Link
            href="/"
            className={cn(
              'flex items-center gap-2.5 rounded-md transition-opacity hover:opacity-80',
              role === null && 'pointer-events-none',
            )}
          >
            <span
              aria-hidden
              className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-[0.6875rem] font-semibold text-accent-foreground"
            >
              Rz
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-sm font-semibold tracking-[-0.011em]">Rizoma</span>
              <span className="text-[0.6875rem] text-muted-foreground">{sectionLabel}</span>
            </span>
          </Link>

          <div className="ml-2 hidden md:block">
            <AppNav role={role} pathname={pathname} />
          </div>

          <div className="ml-auto flex items-center gap-3">
            <DisplayControls />
            <SessionChip session={session} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-4">
          <p className="text-[0.6875rem] text-muted-foreground">
            MVP1 · datos sintéticos de demostración · sin datos clínicos reales
          </p>
        </div>
      </footer>
    </div>
  );
}
