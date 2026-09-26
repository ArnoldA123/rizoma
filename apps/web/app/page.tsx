import { RoleHome } from '@/components/home/role-home';
import { SessionRequiredNotice } from '@/components/session-required-notice';
import { newTraceId } from '@/lib/access';
import { navItemsFor } from '@/lib/navigation';
import { currentSession } from '@/lib/session';
import { primaryRole } from '@/lib/tenant';

/**
 * Home — the day cover of the session role.
 *
 * It does one job and no more: it hands the session role its day cover from
 * `components/home/role-home` (P3-1a/1b), which already covers the 9 salud,
 * obras and auditoría roles with real data and every other role with the
 * neutral summary. The legacy infra cards (service status, screen matrix,
 * action matrix, contracts) were removed in P3-2: they showed platform
 * internals instead of the day. The no-session branch below stays untouched
 * (P1).
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

  // P3-2: every session role renders its day cover — the 9 roles with their
  // own cover plus the neutral summary for the rest. No legacy branch remains.
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
