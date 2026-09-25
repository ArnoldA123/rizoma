import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { IconActivity } from '@/components/ui/icons';
import { API_ORIGIN } from '@/lib/server-config';

/**
 * API reachability card.
 *
 * It probes the one route the API serves outside the `/v1` prefix (`/health`,
 * excluded from the global prefix in `main.ts`) directly from the server. That
 * makes the card a real readiness signal for the demo — and it is also what
 * proves `/health` is reachable without a tenant, which is exactly the
 * behaviour the proxy's `resolveUpstreamPath` has to reproduce.
 */

interface HealthChecks {
  readonly api?: string;
  readonly postgres?: string;
  readonly redis?: string;
}

interface HealthPayload {
  readonly status?: string;
  readonly checks?: HealthChecks;
  readonly traceId?: string;
}

interface ProbeResult {
  readonly reachable: boolean;
  readonly detail: string;
  readonly payload: HealthPayload | null;
  readonly traceId: string;
}

async function probe(): Promise<ProbeResult> {
  const traceId = `web-${crypto.randomUUID()}`;
  try {
    const response = await fetch(`${API_ORIGIN}/health`, {
      headers: { 'x-trace-id': traceId, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) {
      return {
        reachable: false,
        detail: `HTTP ${response.status}`,
        payload: null,
        traceId,
      };
    }
    const payload = (await response.json()) as HealthPayload;
    return { reachable: true, detail: `HTTP ${response.status}`, payload, traceId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reachable: false, detail: detail.slice(0, 120), payload: null, traceId };
  }
}

function checkBadge(name: string, state: string | undefined) {
  const up = state === 'up';
  return (
    <Badge key={name} variant={up ? 'tinted' : 'danger'}>
      {name}: {state ?? 'sin dato'}
    </Badge>
  );
}

export async function ApiStatusCard() {
  const result = await probe();
  const checks = result.payload?.checks ?? {};

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Runtime</CardEyebrow>
        <CardTitle as="h2" className="flex items-center gap-2">
          <IconActivity className={result.reachable ? 'text-accent' : 'text-danger'} />
          API {result.reachable ? 'alcanzable' : 'no alcanzable'}
        </CardTitle>
        <CardDescription>
          <span className="tabular font-mono text-xs">{API_ORIGIN}/health</span> · {result.detail}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {checkBadge('api', checks.api)}
        {checkBadge('postgres', checks.postgres)}
        {checkBadge('redis', checks.redis)}
        <span className="tabular ml-auto font-mono text-[0.6875rem] text-muted-foreground">
          {result.payload?.traceId ?? result.traceId}
        </span>
      </CardContent>
    </Card>
  );
}
