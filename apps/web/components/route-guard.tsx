import type { ReactNode } from 'react';
import { DeniedNotice } from '@/components/denied-notice';
import { SessionRequiredNotice } from '@/components/session-required-notice';
import { guardPage, type PageGuard } from '@/lib/page-guard';

/**
 * Route guard boundary — the one place a page turns a decision into markup.
 *
 * Three outcomes, three honest screens: no identity, identity without the
 * required action, and the real page. The denial carries the action that was
 * missing so the copy can name what the role lacks instead of a generic
 * "forbidden".
 */
export interface RouteGuardProps {
  readonly path: string;
  readonly children: (guard: PageGuard) => ReactNode;
}

export async function RouteGuard({ path, children }: RouteGuardProps): Promise<ReactNode> {
  const guard = await guardPage(path);

  if (!guard.session.identity.ok) {
    return (
      <SessionRequiredNotice
        code={guard.session.identity.code}
        reason={guard.session.identity.reason}
        message={guard.session.identity.message}
        traceId={guard.traceId}
        status={401}
      />
    );
  }

  if (!guard.decision.allow) {
    return (
      <DeniedNotice
        reason={guard.decision.reason}
        traceId={guard.traceId}
        role={guard.role}
        code="access.denied"
        status={403}
        {...(guard.decision.denied[0] === undefined ? {} : { action: guard.decision.denied[0] })}
      />
    );
  }

  return <>{children(guard)}</>;
}
