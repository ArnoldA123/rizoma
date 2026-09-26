import { PageHeader } from '@/components/page-header';
import { RouteGuard } from '@/components/route-guard';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardEyebrow,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { IconAlertTriangle, IconLock, IconShieldCheck } from '@/components/ui/icons';
import { ACTION_CODES, ROLE_CODES, ROLE_PERMISSIONS } from '@/lib/access';
import { actionLabel, roleLabel } from '@/lib/labels';
import { API_ORIGIN } from '@/lib/server-config';
import { currentAccessToken } from '@/lib/session';
import {
  POLICY_PREVIEW_ENTITIES,
  policyPreviewQueryString,
  policyPreviewSchema,
  type PolicyPreview,
  type PolicyPreviewEntity,
} from '@rizoma/contracts';

/**
 * `/politicas` — audit read-only of the authorization policy (B5).
 *
 * Two blocks, both without any logic builder: the full role × action matrix
 * (rendered from the same `@/lib/access` mirror the nav guard uses) and a
 * tester that asks `GET /v1/policy/preview` what a role may do in a given
 * state, per the matrix and the `state_transitions` catalog. The page never
 * grants anything — it only exposes what the code already decides.
 *
 * The tester submits a GET form so no client JavaScript is needed: the server
 * reads `searchParams` and probes the API directly with the session token,
 * exactly like `ApiStatusCard` probes `/health`.
 */
export const dynamic = 'force-dynamic';

/** States the closed catalog seeds, offered as suggestions (free text stays). */
const KNOWN_STATES = [
  'open',
  'closed',
  'cancelled',
  'registered',
  'approved',
  'rejected',
  'adjusted',
  'draft',
  'published',
] as const;

type PreviewOutcome =
  | { readonly status: 'idle' }
  | { readonly status: 'login' }
  | { readonly status: 'unreachable'; readonly detail: string }
  | { readonly status: 'error'; readonly code: string; readonly message: string }
  | { readonly status: 'ok'; readonly preview: PolicyPreview };

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

async function fetchPreview(
  role: string,
  entity: PolicyPreviewEntity,
  estado: string,
): Promise<PreviewOutcome> {
  const token = await currentAccessToken();
  if (token === null) return { status: 'login' };
  const query = policyPreviewQueryString({ role, entity, estado });
  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}/v1/policy/preview${query}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'x-trace-id': `web-politicas-${crypto.randomUUID()}`,
      },
      cache: 'no-store',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: 'unreachable', detail: detail.slice(0, 160) };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    return { status: 'error', code: 'api.invalid_json', message: 'El API respondió sin JSON.' };
  }
  if (!response.ok) {
    const envelope = payload as { code?: unknown; message?: unknown };
    return {
      status: 'error',
      code: typeof envelope.code === 'string' ? envelope.code : `http.${response.status}`,
      message:
        typeof envelope.message === 'string' ? envelope.message : `HTTP ${response.status}`,
    };
  }
  const parsed = policyPreviewSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: 'error',
      code: 'api.contract_mismatch',
      message: 'La respuesta del API no cumple el contrato de previsualización.',
    };
  }
  return { status: 'ok', preview: parsed.data };
}

function TesterResult({ outcome }: { readonly outcome: PreviewOutcome }) {
  if (outcome.status === 'idle') {
    return (
      <Alert variant="muted" title="Sin consulta todavía">
        <p>
          Elija un rol, una entidad y un estado y pulse «Probar»: el resultado muestra las
          acciones permitidas y los cambios de estado que ese rol puede tomar desde ahí.
        </p>
      </Alert>
    );
  }
  if (outcome.status === 'login') {
    return (
      <Alert variant="muted" icon={<IconLock className="mt-0.5 h-4 w-4" />} title="Sesión requerida">
        <p>
          El probador consulta el API con su sesión. Inicie sesión para ver el resultado; la
          matriz de abajo no necesita sesión.
        </p>
      </Alert>
    );
  }
  if (outcome.status === 'unreachable') {
    return (
      <Alert
        variant="denied"
        icon={<IconAlertTriangle className="mt-0.5 h-4 w-4 text-danger" />}
        title="API inalcanzable"
      >
        <p>
          No se pudo contactar el API (<code className="font-mono text-xs">{outcome.detail}</code>
          ). La matriz de abajo es el espejo local y sigue disponible.
        </p>
      </Alert>
    );
  }
  if (outcome.status === 'error') {
    return (
      <Alert
        variant="denied"
        icon={<IconAlertTriangle className="mt-0.5 h-4 w-4 text-danger" />}
        title="El API rechazó la consulta"
      >
        <p>
          <code className="font-mono text-xs">{outcome.code}</code>: {outcome.message}
        </p>
      </Alert>
    );
  }
  const { preview } = outcome;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">
          {roleLabel(preview.role)} · {preview.entity} en «{preview.estado}»
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {preview.permittedActions.length} acciones permitidas de{' '}
          {preview.permittedActions.length + preview.deniedActions.length} ·{' '}
          {preview.transitions.filter((move) => move.allowed).length} cambios de estado
          permitidos de {preview.transitions.length}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {preview.permittedActions.map((action) => (
          <Badge key={action} title={action}>
            {actionLabel(action)}
          </Badge>
        ))}
        {preview.permittedActions.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Ninguna acción: el rol está denegado por omisión.
          </span>
        ) : null}
      </div>
      {preview.transitions.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-xl border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="border-b border-border px-2 py-1.5 font-medium">Cambio</th>
                <th className="border-b border-border px-2 py-1.5 font-medium">Acción exigida</th>
                <th className="border-b border-border px-2 py-1.5 font-medium">En catálogo</th>
                <th className="border-b border-border px-2 py-1.5 font-medium">En matriz</th>
                <th className="border-b border-border px-2 py-1.5 font-medium">Veredicto</th>
              </tr>
            </thead>
            <tbody>
              {preview.transitions.map((move) => (
                <tr key={move.to} className="border-b border-border/60 last:border-0">
                  <td className="px-2 py-1.5 font-mono text-xs">
                    {move.from} → {move.to}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-xs">{move.action}</td>
                  <td className="px-2 py-1.5">{move.roleListed ? 'Sí' : 'No'}</td>
                  <td className="px-2 py-1.5">{move.rolePermits ? 'Sí' : 'No'}</td>
                  <td className="px-2 py-1.5 font-medium">
                    {move.allowed ? 'Permitido' : 'Denegado'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          El catálogo no lista ningún cambio desde «{preview.estado}»: todo movimiento desde ahí
          está denegado.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {preview.boards.map((board) => (
          <Badge
            key={board.board}
            variant={board.allowed ? undefined : 'outline'}
            title={`${board.board}: exige ${board.action}`}
          >
            Tablero {roleLabel(board.board)}: {board.allowed ? 'sí' : 'no'}
          </Badge>
        ))}
      </div>
    </div>
  );
}

export default async function PoliticasPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const role = firstParam(params.role).trim();
  const entityRaw = firstParam(params.entity).trim();
  const estado = firstParam(params.estado).trim();
  const entity = (POLICY_PREVIEW_ENTITIES as readonly string[]).includes(entityRaw)
    ? (entityRaw as PolicyPreviewEntity)
    : null;
  const outcome: PreviewOutcome =
    role === '' || entity === null || estado === ''
      ? { status: 'idle' }
      : await fetchPreview(role, entity, estado);

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Auditoría · políticas"
        title="Políticas de acceso"
        description="Matriz rol × acción y probador por estado: solo lectura de lo que el código ya decide, sin constructor de reglas."
        badges={['solo lectura']}
      />

      <RouteGuard path="/politicas">
        {() => (
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader>
                <CardEyebrow>Probador por rol y estado</CardEyebrow>
                <CardTitle as="h2">¿Qué puede hacer este rol en este estado?</CardTitle>
                <CardDescription>
                  Consulta <code className="font-mono text-xs">GET /v1/policy/preview</code>: la
                  matriz más el catálogo <code className="font-mono text-xs">state_transitions</code>{' '}
                  del tenant.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <form method="get" action="/politicas" className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">Rol</span>
                    <select
                      name="role"
                      defaultValue={role}
                      className="rounded-md border border-border bg-card px-2 py-1.5"
                    >
                      <option value="">Elegir…</option>
                      {ROLE_CODES.map((code) => (
                        <option key={code} value={code}>
                          {roleLabel(code)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">Entidad</span>
                    <select
                      name="entity"
                      defaultValue={entity ?? ''}
                      className="rounded-md border border-border bg-card px-2 py-1.5"
                    >
                      <option value="">Elegir…</option>
                      {POLICY_PREVIEW_ENTITIES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-xs text-muted-foreground">Estado</span>
                    <input
                      name="estado"
                      defaultValue={estado}
                      placeholder="open"
                      list="politicas-estados"
                      className="rounded-md border border-border bg-card px-2 py-1.5 font-mono text-xs"
                    />
                    <datalist id="politicas-estados">
                      {KNOWN_STATES.map((state) => (
                        <option key={state} value={state} />
                      ))}
                    </datalist>
                  </label>
                  <button
                    type="submit"
                    className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-medium"
                  >
                    Probar
                  </button>
                </form>
                <TesterResult outcome={outcome} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardEyebrow>Matriz rol × acción</CardEyebrow>
                <CardTitle as="h2">Quién puede hacer qué</CardTitle>
                <CardDescription>
                  Espejo local de la matriz del API: «Sí» es una concesión explícita, el guion es
                  denegación por omisión. Los roles transversales (
                  {roleLabel('vendedor')}, {roleLabel('soporte')}) no tienen concesiones en esta
                  matriz.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-3xl border-collapse text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="sticky left-0 bg-card px-2 py-1.5 font-medium">Rol</th>
                      {ACTION_CODES.map((action) => (
                        <th
                          key={action}
                          title={actionLabel(action)}
                          className="px-2 py-1.5 font-mono text-[0.6875rem] font-medium"
                        >
                          {action}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROLE_CODES.map((code) => (
                      <tr key={code} className="border-t border-border/60">
                        <th
                          scope="row"
                          className="sticky left-0 bg-card px-2 py-1.5 text-left font-medium"
                        >
                          {roleLabel(code)}
                        </th>
                        {ACTION_CODES.map((action) => (
                          <td key={action} className="px-2 py-1.5 text-center">
                            {ROLE_PERMISSIONS[code].has(action) ? (
                              <span className="font-medium text-accent" title={actionLabel(action)}>
                                Sí
                              </span>
                            ) : (
                              <span className="text-muted-foreground" title="Denegado por omisión">
                                —
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Alert
              variant="muted"
              icon={<IconShieldCheck className="mt-0.5 h-4 w-4" />}
              title="La autoridad sigue en el API"
            >
              <p>
                Esta pantalla no decide nada: el resguardo del navegador es preventivo y el API
                vuelve a evaluar cada solicitud. Un rol desconocido responde con todo denegado,
                que es la propiedad de denegación por omisión hecha visible.
              </p>
            </Alert>
          </div>
        )}
      </RouteGuard>
    </div>
  );
}
