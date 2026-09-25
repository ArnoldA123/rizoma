// Browser API client.
//
// Every call goes to the same-origin proxy (`app/api/proxy/[...path]`), never
// to the API origin directly: the proxy owns the bearer token, the
// `Idempotency-Key` passthrough and the correlation id, so the browser never
// needs CORS and never needs to hold the access token. That is the whole point
// of the proxy — the API has no `enableCors` and this work unit does not add
// one.
//
// Response bodies are validated by the caller's Zod schema (from
// `@rizoma/contracts`), so a shape drift fails loudly at the edge instead of
// producing `undefined` deep inside a screen.
import { type ZodType } from 'zod';
import {
  DEV_IDENTITY,
  IDEMPOTENCY_KEY_HEADER,
  PROXY_BASE_PATH,
  SCOPES_HEADER,
  TENANT_ID_HEADER,
  TRACE_ID_HEADER,
  USER_ID_HEADER,
  devIdentityConfigured,
} from './config.ts';
import { TRANSPORT_ERROR_CODE, parseApiError, resolveTraceId } from './http.ts';

/** Mutation verbs; reads never carry an `Idempotency-Key`. */
export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One request as a screen describes it. */
export interface ApiRequestInit {
  readonly method?: ApiMethod;
  /** Serialized as JSON unless it is already a string. */
  readonly body?: unknown;
  /**
   * Replay key for a critical mutation (`POST /billing/invoices/issue` and
   * friends). Call {@link newIdempotencyKey} once per user intent — never per
   * retry, that is exactly the case the key has to collapse.
   */
  readonly idempotencyKey?: string;
  /** Correlation id; generated when omitted so every call is traceable. */
  readonly traceId?: string;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Typed failure carrying the envelope fields the UI displays verbatim. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly traceId: string;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    traceId: string;
    reason?: string;
  }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.status = init.status;
    this.code = init.code;
    this.traceId = init.traceId;
    if (init.reason !== undefined) this.reason = init.reason;
  }

  /** `{code, reason, traceId}` as the denial panel renders it. */
  toDenial(): { code: string; reason: string; traceId: string } {
    return { code: this.code, reason: this.reason ?? this.code, traceId: this.traceId };
  }
}

/** Fresh correlation id for one user action. */
export function newTraceId(): string {
  return `web-${globalThis.crypto.randomUUID()}`;
}

/** Fresh idempotency key for one critical mutation intent. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Absolute same-origin URL of one proxied path. */
export function proxyUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${PROXY_BASE_PATH}${normalized}`;
}

function buildHeaders(init: ApiRequestInit): Headers {
  const headers = new Headers(init.headers ?? {});
  headers.set('accept', 'application/json');
  if (!headers.has(TRACE_ID_HEADER)) {
    headers.set(TRACE_ID_HEADER, init.traceId ?? newTraceId());
  }
  if (init.idempotencyKey !== undefined) {
    headers.set(IDEMPOTENCY_KEY_HEADER, init.idempotencyKey);
  }
  // Local fallback identity: the proxy uses it only when there is no session
  // token, and only outside production. Harmless (and ignored) otherwise, so a
  // developer keeps working when Keycloak is down.
  if (devIdentityConfigured()) {
    headers.set(TENANT_ID_HEADER, DEV_IDENTITY.tenantId);
    headers.set(USER_ID_HEADER, DEV_IDENTITY.userId);
    if (DEV_IDENTITY.scopes !== '') headers.set(SCOPES_HEADER, DEV_IDENTITY.scopes);
  }
  return headers;
}

function buildBody(init: ApiRequestInit, headers: Headers): BodyInit | undefined {
  if (init.body === undefined) return undefined;
  if (typeof init.body === 'string') return init.body;
  headers.set('content-type', 'application/json');
  return JSON.stringify(init.body);
}

/**
 * Sends one request through the proxy and returns the raw `Response`.
 * `credentials: 'same-origin'` is explicit: the session cookie is the only
 * credential, and it must never leak to a third-party origin.
 */
export async function proxyRequest(path: string, init: ApiRequestInit = {}): Promise<Response> {
  const headers = buildHeaders(init);
  const body = buildBody(init, headers);
  return fetch(proxyUrl(path), {
    method: init.method ?? 'GET',
    headers,
    body,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
}

async function toApiRequestError(response: Response): Promise<ApiRequestError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const envelope = parseApiError(payload);
  const traceId = resolveTraceId(response.headers, envelope) ?? newTraceId();
  if (envelope === null) {
    return new ApiRequestError({
      status: response.status,
      code: 'api.unexpected_response',
      message: `Respuesta no tipificada del API (HTTP ${response.status}).`,
      traceId,
    });
  }
  return new ApiRequestError({
    status: response.status,
    code: envelope.code,
    message: envelope.message,
    traceId,
    ...(envelope.reason === undefined ? {} : { reason: envelope.reason }),
  });
}

/**
 * Performs one request, validates the parsed body with `schema` and throws
 * {@link ApiRequestError} on any non-2xx answer. A `204` or an empty body
 * returns `null` instead of failing the schema, so delete-style routes work.
 */
export async function requestJson<T>(
  path: string,
  schema: ZodType<T>,
  init: ApiRequestInit = {},
): Promise<T | null> {
  const response = await proxyRequest(path, init);
  if (!response.ok) throw await toApiRequestError(response);

  const text = await response.text();
  if (text.trim() === '') return null;

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ApiRequestError({
      status: response.status,
      code: 'api.invalid_json',
      message: 'El API respondió con un cuerpo que no es JSON.',
      traceId: resolveTraceId(response.headers) ?? newTraceId(),
    });
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApiRequestError({
      status: response.status,
      code: 'api.contract_mismatch',
      message: 'La respuesta del API no cumple el contrato declarado en @rizoma/contracts.',
      traceId: resolveTraceId(response.headers) ?? newTraceId(),
      reason: result.error.issues.map((issue) => issue.path.join('.')).join(', '),
    });
  }
  return result.data;
}

/** Same as {@link requestJson} for endpoints whose body is not consumed. */
export async function requestVoid(path: string, init: ApiRequestInit = {}): Promise<void> {
  const response = await proxyRequest(path, init);
  if (!response.ok) throw await toApiRequestError(response);
}

/**
 * Typed failure of an already-obtained non-2xx response.
 *
 * Exported for the one caller that needs the raw `Response` and not just its
 * body: the CSV download of the imports screen reads `content-disposition`
 * (the proxy forwards it) before materializing the attachment, so it cannot go
 * through {@link requestJson}.
 */
export async function apiErrorFromResponse(response: Response): Promise<ApiRequestError> {
  return toApiRequestError(response);
}

/** Transport-level failure used when the proxy itself cannot reach the API. */
export function transportError(traceId: string, detail: string): ApiRequestError {
  return new ApiRequestError({
    status: 502,
    code: TRANSPORT_ERROR_CODE,
    message: detail,
    traceId,
  });
}
