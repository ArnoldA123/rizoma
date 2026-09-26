import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { IconActivity } from '@/components/ui/icons';
import { API_ORIGIN } from '@/lib/server-config';

/**
 * API reachability card.
 *
 * The visible body stays plain language (available or not, who to tell). The
 * probe facts — origin, `/health`, HTTP status, per-check states and trace id
 * — render only inside the collapsed detail. The card itself stays on screen;
 * removing it is P3's call, not P1's.
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

export async function ApiStatusCard() {
  const result = await probe();
  const checks = result.payload?.checks ?? {};
  const detail = [
    `origin: ${API_ORIGIN}/health`,
    `status: ${result.detail}`,
    `api: ${checks.api ?? '—'}`,
    `postgres: ${checks.postgres ?? '—'}`,
    `redis: ${checks.redis ?? '—'}`,
    `traceId: ${result.payload?.traceId ?? result.traceId}`,
  ].join('\n');

  return (
    <Card>
      <CardHeader>
        <CardEyebrow>Servicio</CardEyebrow>
        <CardTitle as="h2" className="flex items-center gap-2">
          <IconActivity className={result.reachable ? 'text-accent' : 'text-danger'} />
          {result.reachable ? 'Servicio disponible' : 'Servicio no disponible'}
        </CardTitle>
        <CardDescription>
          {result.reachable
            ? 'El servicio responde con normalidad.'
            : 'No pudimos contactar el servicio. Avise a soporte.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {result.reachable ? null : <p>Si el problema sigue, avise a soporte.</p>}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
            Copiar detalle
          </summary>
          <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
            {detail}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
