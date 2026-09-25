// Session introspection for client components.
//
// Returns the *derived* identity only — tenant, user, roles and scopes — never
// the access token. Client components need the role to filter affordances,
// and this is the smallest answer that lets them do it without putting the
// credential in the browser.
import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();

  if (!session.identity.ok) {
    return NextResponse.json(
      {
        code: session.identity.code,
        message: session.identity.message,
        reason: session.identity.reason,
        traceId: `web-${crypto.randomUUID()}`,
      },
      { status: 401 },
    );
  }

  const identity = session.identity.identity;
  return NextResponse.json(
    {
      authenticated: session.tokens !== null,
      expired: session.expired,
      source: identity.source,
      tenantId: identity.tenantId,
      userId: identity.userId,
      roles: identity.roles,
      scopes: identity.scopes,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
