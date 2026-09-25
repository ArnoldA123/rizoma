import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { GRID_COOKIE, PATH_HEADER, THEME_COOKIE } from '@/lib/config';
import { matchRoute } from '@/lib/navigation';
import { currentSession } from '@/lib/session';

/**
 * Root layout.
 *
 * Two decisions worth naming:
 * - The colour scheme is resolved on the server from the preference cookie, so
 *   the first byte already carries the right theme. The tiny inline script is
 *   only a fallback for the very first visit, where no cookie exists yet and
 *   the system preference has to be read before paint.
 * - The skin comes from the route table via the `x-rizoma-path` header the
 *   middleware stamps, which keeps the shell, the nav and the guard reading the
 *   same declaration.
 */
export const metadata: Metadata = {
  title: 'Rizoma · MVP1',
  description:
    'Web de Salud y Obras contra el API verificado. Datos sintéticos de demostración, sin datos clínicos reales.',
  robots: { index: false, follow: false },
};

const THEME_BOOTSTRAP = `(function(){try{var root=document.documentElement;if(!root.dataset.theme){root.dataset.theme=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}}catch(error){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [cookieStore, headerBag, session] = await Promise.all([
    cookies(),
    headers(),
    currentSession(),
  ]);

  const storedTheme = cookieStore.get(THEME_COOKIE)?.value;
  const theme = storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : undefined;
  const grid = cookieStore.get(GRID_COOKIE)?.value === 'off' ? 'off' : 'on';

  const pathname = headerBag.get(PATH_HEADER) ?? '/';
  const matched = matchRoute(pathname);

  return (
    <html lang="es" data-theme={theme} data-grid={grid} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <AppShell
          skin={matched?.route.skin ?? 'neutral'}
          pathname={pathname}
          route={matched?.route ?? null}
          session={session}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
