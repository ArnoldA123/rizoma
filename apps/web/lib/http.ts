// HTTP transport helpers: the `{code, message, traceId}` envelope contract of
// `main.ts` / the tenant middleware, decoded in one place so every caller sees
// the same shape.
//
// The envelope schema lives in `@rizoma/contracts` (the non-web consumers need
// it too), so this module stays a thin, testable adapter instead of a second
// source of truth.
import { apiErrorSchema, type ApiError } from '@rizoma/contracts';
import { TRACE_ID_HEADER } from './config.ts';

/** Error code used when the web layer cannot reach the API at all. */
export const TRANSPORT_ERROR_CODE = 'proxy.unavailable';

/** Normalized envelope as the UI renders it. */
export interface ApiErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly reason?: string;
  readonly traceId?: string;
}

/** True when `body` is a well-formed API error envelope. */
export function isApiErrorPayload(body: unknown): body is ApiErrorPayload {
  return apiErrorSchema.safeParse(body).success;
}

/** Parses a response body into the envelope, or `null` when it is not one. */
export function parseApiError(body: unknown): ApiErrorPayload | null {
  const result = apiErrorSchema.safeParse(body);
  if (!result.success) return null;
  const parsed: ApiError = result.data;
  return parsed;
}

/**
 * Correlation id of a response: the `x-trace-id` header when present (the
 * middleware echoes it on every rejection), otherwise the envelope's own
 * `traceId`.
 */
export function resolveTraceId(headers: Headers, payload?: ApiErrorPayload | null): string | undefined {
  return headers.get(TRACE_ID_HEADER) ?? payload?.traceId ?? undefined;
}
