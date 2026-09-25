// API proxy — the single network path from the browser to the API.
//
// Contract per request:
//   - `/api/proxy/<path>`  →  `${API_ORIGIN}/v1/<path>` (except `/health`,
//     which the API serves outside the `/v1` prefix).
//   - `Authorization: Bearer <access token>` is injected from the `HttpOnly`
//     session cookie; the browser never sends it and never sees it.
//   - `Idempotency-Key` and `x-trace-id` are forwarded verbatim: the client
//     owns the replay key of a critical mutation, and the correlation id has to
//     survive the hop so a UI error and an API log line share one value.
//   - Only outside production, and only when no token is present, the local
//     `x-tenant-id` / `x-user-id` / `x-scopes` headers are forwarded, which is
//     the documented development fallback of the tenant middleware.
//   - The upstream status and body are returned unchanged, so the client sees
//     the real `{code, message, traceId}` envelope (a 403 stays a 403, a 409
//     duplicate stays a 409) instead of a laundered 200.
import { NextResponse, type NextRequest } from 'next/server';
import {
  IDEMPOTENCY_KEY_HEADER,
  SCOPES_HEADER,
  SESSION_COOKIE,
  TENANT_ID_HEADER,
  TRACE_ID_HEADER,
  USER_ID_HEADER,
} from '@/lib/config';
import { TRANSPORT_ERROR_CODE } from '@/lib/http';
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  newProxyTraceId,
  resolveUpstreamPath,
} from '@/lib/proxy';
import { API_ORIGIN, DEV_HEADERS_ENABLED } from '@/lib/server-config';
import { decodeSession, sessionIsExpired } from '@/lib/session-codec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Request methods the proxy relays. `HEAD` is answered like `GET`. */
const ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD'];

function errorResponse(status: number, code: string, message: string, traceId: string): NextResponse {
  return NextResponse.json(
    { code, message, traceId },
    { status, headers: { 'cache-control': 'no-store', [TRACE_ID_HEADER]: traceId } },
  );
}

async function handle(request: NextRequest, path: readonly string[]): Promise<NextResponse> {
  const incomingTraceId = request.headers.get(TRACE_ID_HEADER);
  const traceId =
    incomingTraceId === null || incomingTraceId.trim() === ''
      ? newProxyTraceId()
      : incomingTraceId.trim();

  if (!ALLOWED_METHODS.includes(request.method)) {
    return errorResponse(
      405,
      'proxy.method_not_allowed',
      `Método no permitido por el proxy: ${request.method}.`,
      traceId,
    );
  }

  const upstreamPath = resolveUpstreamPath(path);
  if (upstreamPath === null) {
    return errorResponse(
      400,
      'proxy.invalid_path',
      'La ruta solicitada no es válida para el API.',
      traceId,
    );
  }

  const stored = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  const accessToken = stored !== null && !sessionIsExpired(stored) ? stored.accessToken : null;

  const headers = buildUpstreamHeaders({
    accessToken,
    ...(DEV_HEADERS_ENABLED && accessToken === null
      ? {
          devIdentity: {
            tenantId: request.headers.get(TENANT_ID_HEADER),
            userId: request.headers.get(USER_ID_HEADER),
            scopes: request.headers.get(SCOPES_HEADER),
          },
        }
      : {}),
    idempotencyKey: request.headers.get(IDEMPOTENCY_KEY_HEADER),
    traceId,
    accept: request.headers.get('accept'),
    contentType: request.headers.get('content-type'),
  });

  // A GET/HEAD never carries a body; anything else is relayed byte for byte so
  // the API's own ValidationPipe sees exactly what the client sent.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_ORIGIN}${upstreamPath}${request.nextUrl.search}`, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorResponse(
      502,
      TRANSPORT_ERROR_CODE,
      `No se pudo alcanzar el API (${API_ORIGIN}): ${detail}`,
      traceId,
    );
  }

  const responseHeaders = new Headers();
  copyResponseHeaders(upstream.headers, responseHeaders, traceId);
  const payload = await upstream.arrayBuffer();
  return new NextResponse(payload.byteLength === 0 ? null : payload, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

type RouteContext = { readonly params: Promise<{ readonly path: readonly string[] }> };

async function relay(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { path } = await context.params;
  return handle(request, path);
}

export function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return relay(request, context);
}

export function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return relay(request, context);
}

export function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return relay(request, context);
}

export function PUT(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return relay(request, context);
}

export function DELETE(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return relay(request, context);
}

export function HEAD(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return relay(request, context);
}
