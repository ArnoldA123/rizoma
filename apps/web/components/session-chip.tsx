import { Suspense, cache } from 'react';
import Link from 'next/link';
import { orgNodeListSchema, userListSchema } from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { IconLogOut } from '@/components/ui/icons';
import { primaryRole } from '@/lib/tenant';
import { roleLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { CurrentSession } from '@/lib/session';
import {
  AUTHORIZATION_HEADER,
  DEV_IDENTITY,
  SCOPES_HEADER,
  TENANT_ID_HEADER,
  TRACE_ID_HEADER,
  USER_ID_HEADER,
  devIdentityConfigured,
} from '@/lib/config';
import { API_ORIGIN, DEV_HEADERS_ENABLED } from '@/lib/server-config';

// Server-only module: it reads the API origin and forwards the session bearer,
// so it must never be imported from a Client Component. The async islands
// below stream inside `<Suspense>` — the role badge and the exit action paint
// first, and the name/sede lines arrive when the upstream answers.

/**
 * Session chip — who is acting and how to leave.
 *
 * Async server component on purpose: the role badge and the exit action are
 * known from the session and paint immediately through the `Suspense`
 * fallback in `AppShell`, while the person name (`GET /v1/users`, matched by
 * `identity.userId`) and the sede (`GET /v1/org/nodes`, matched by the row's
 * `orgNodeId`) stream in when the upstream answers. Every read is fail-soft —
 * without a name the chip shows only the role, without a sede it shows
 * «Sede no asignada» — so a slow or failed listing never blocks the header.
 *
 * The visible chip shows only the name, the role, the sede and the exit
 * action: tenant and user ids, identity source and envelope fields never
 * render here.
 */
export interface SessionChipProps {
  readonly session: CurrentSession;
}

export async function SessionChip({ session }: SessionChipProps) {
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
  const accessToken = session.tokens?.accessToken ?? null;
  const userId = identity.identity.userId;

  return (
    <div className="flex items-center gap-2.5">
      <Suspense fallback={null}>
        <SessionName userId={userId} accessToken={accessToken} />
      </Suspense>
      <Badge variant="accent">{roleLabel(role)}</Badge>
      <Suspense fallback={null}>
        <SessionSede userId={userId} accessToken={accessToken} />
      </Suspense>
      <ExitAction />
    </div>
  );
}

/**
 * Instant fallback for the header: role plus exit, no upstream read. `AppShell`
 * renders it while the async `SessionChip` streams, so the header never waits
 * for the users/org listings.
 */
export function SessionChipFallback({ role }: { readonly role: string | null }) {
  return (
    <div className="flex items-center gap-2.5">
      <Badge variant="accent">{roleLabel(role)}</Badge>
      <ExitAction />
    </div>
  );
}

/** Exit action, shared by the chip and its fallback so both offer the same way out. */
function ExitAction() {
  return (
    <Link
      href="/api/auth/logout"
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
      title="Cerrar sesión"
    >
      <IconLogOut />
      <span className="hidden sm:inline">Salir</span>
    </Link>
  );
}

/**
 * How long an identity island waits for the upstream before falling back.
 * Past this budget the chip renders the soft fallback (role only / «Sede no
 * asignada») instead of holding its `Suspense` slot open.
 */
const IDENTITY_TIMEOUT_MS = 2500;

/**
 * Upstream headers for a server-side listing read: the session bearer wins,
 * exactly like the proxy contract in `lib/proxy.ts`; the local development
 * headers are forwarded only without a token and only when enabled, so the
 * browser never picks its own tenant. Returns `null` when neither source can
 * supply an identity — the islands then render their fallbacks, not a fetch.
 */
function identityUpstreamHeaders(accessToken: string | null): Headers | null {
  const headers = new Headers();
  headers.set('accept', 'application/json');
  headers.set(TRACE_ID_HEADER, `web-${crypto.randomUUID()}`);
  if (accessToken !== null && accessToken !== '') {
    headers.set(AUTHORIZATION_HEADER, `Bearer ${accessToken}`);
    return headers;
  }
  if (DEV_HEADERS_ENABLED && devIdentityConfigured()) {
    headers.set(TENANT_ID_HEADER, DEV_IDENTITY.tenantId);
    headers.set(USER_ID_HEADER, DEV_IDENTITY.userId);
    if (DEV_IDENTITY.scopes !== '') headers.set(SCOPES_HEADER, DEV_IDENTITY.scopes);
    return headers;
  }
  return null;
}

/**
 * One server-side listing read against the API origin — the same endpoint and
 * contract the browser `listUsers` / `listOrgNodes` clients read through the
 * proxy, validated with the same `@rizoma/contracts` schema. Any transport,
 * status or contract failure answers `null`: the islands render fallbacks.
 */
async function readUpstreamList<T>(
  path: '/v1/users' | '/v1/org/nodes',
  schema: ZodType<T>,
  accessToken: string | null,
): Promise<T | null> {
  const headers = identityUpstreamHeaders(accessToken);
  if (headers === null) return null;
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Listing readers shared by both islands, memoized per render with `cache`:
 * name and sede resolve from one `/v1/users` read, plus one `/v1/org/nodes`
 * read only when the user row carries an org node.
 */
const readUsers = cache((accessToken: string | null) =>
  readUpstreamList('/v1/users', userListSchema, accessToken),
);
const readOrgNodes = cache((accessToken: string | null) =>
  readUpstreamList('/v1/org/nodes', orgNodeListSchema, accessToken),
);

/** Person name of the session user, or nothing when the listing has no name. */
async function SessionName({
  userId,
  accessToken,
}: {
  readonly userId: string;
  readonly accessToken: string | null;
}) {
  const users = await readUsers(accessToken);
  const name = users?.find((row) => row.id === userId)?.name.trim() ?? '';
  // Sin nombre → solo rol: the badge beside this island already names the role.
  if (name === '') return null;
  return <span className="text-sm font-medium">{name}</span>;
}

/** Sede of the session user, with the unassigned fallback when unknown. */
async function SessionSede({
  userId,
  accessToken,
}: {
  readonly userId: string;
  readonly accessToken: string | null;
}) {
  const users = await readUsers(accessToken);
  const orgNodeId = users?.find((row) => row.id === userId)?.orgNodeId ?? null;
  let sede: string | null = null;
  if (orgNodeId !== null) {
    const nodes = await readOrgNodes(accessToken);
    const found = nodes?.find((node) => node.id === orgNodeId)?.name.trim() ?? '';
    sede = found === '' ? null : found;
  }
  return (
    <span className="hidden text-xs text-muted-foreground sm:inline">
      {sede ?? 'Sede no asignada'}
    </span>
  );
}
