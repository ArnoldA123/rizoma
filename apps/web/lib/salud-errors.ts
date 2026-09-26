// Failure classification for the Salud screens.
//
// One place turns whatever a call threw into the four facts the UI is allowed to
// show — `code`, `reason`, `traceId` and a coarse `kind` — plus a short hint
// that says what the user can do about it. Two properties are load-bearing:
//
//   1. Nothing is invented. A field that the API did not send stays `null` and
//      the panel renders a dash, instead of the UI guessing at a cause.
//   2. Nothing leaks. The classification never reads tenant data, a record body
//      or a stack trace: a refusal must not become an information channel.
//
// The known base gap of W2 is modelled explicitly: `GET /v1/salud/patients`
// answers an *untyped* 500 when the caller has no `memberships` row, which the
// proxy relays unchanged. That body is not an `{code, message, traceId}`
// envelope, so `api-client.ts` reports it as `api.unexpected_response` with a
// status of 500. `kind: 'untyped_server_error'` is what lets a screen render a
// typed error state and name the two plausible causes instead of a bare
// "error 500".
import { ApiRequestError } from './api-client.ts';

/** Coarse class of a failed call, as a screen switches on it. */
export type ApiFailureKind =
  | 'denied'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'untyped_server_error'
  | 'server_error'
  | 'transport'
  | 'contract'
  | 'client'
  | 'unexpected';

/** Everything a failure panel may render, and nothing else. */
export interface ApiFailure {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  /** Machine code (`access.denied`, `api.unexpected_response`, …). */
  readonly code: string;
  /** Guard reason of a denial, when the API sent one. */
  readonly reason: string | null;
  readonly traceId: string | null;
  /** Warm motive line in neutral Spanish (never the raw envelope message). */
  readonly message: string;
  /** What the user can do about it; never a guess about remote state. */
  readonly hint: string;
}

function fromError(error: Error): ApiFailure {
  return {
    kind: 'client',
    status: null,
    code: 'client.error',
    reason: null,
    traceId: null,
    message: error.message,
    hint: 'La solicitud no se llegó a enviar. Corrija el dato señalado y vuelva a intentarlo.',
  };
}

function classifyStatus(status: number, code: string): ApiFailureKind {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'denied';
    case 403:
      return 'denied';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 500:
    case 501:
    case 502:
    case 503:
      if (code === 'proxy.unavailable') return 'transport';
      // `api.unexpected_response` means the body was not the API's own
      // envelope; anything else is a 5xx the API typed itself.
      return code === 'api.unexpected_response' ? 'untyped_server_error' : 'server_error';
    default:
      return 'unexpected';
  }
}

/**
 * Warm motive line per failure kind, in neutral Spanish. The envelope message
 * can arrive in English with machine tokens (`Access denied: role.denied`),
 * so the visible motive never quotes it: codes, reasons and trace ids travel
 * only inside the collapsed "Copiar detalle" of the panel.
 */
function messageFor(kind: ApiFailureKind): string {
  switch (kind) {
    case 'denied':
      return 'No tiene permiso para esta operación.';
    case 'not_found':
      return 'No encontramos ese registro.';
    case 'validation':
      return 'Hay un dato por corregir.';
    case 'conflict':
      return 'Ese registro ya existe.';
    case 'transport':
      return 'No pudimos comunicarnos con el servicio.';
    case 'server_error':
      return 'El servicio tuvo un problema interno.';
    case 'contract':
      return 'La respuesta llegó incompleta.';
    case 'untyped_server_error':
      return 'El servicio tuvo un problema interno.';
    default:
      return 'Ocurrió un problema inesperado.';
  }
}

/** What the user can do about it, in neutral Spanish and without jargon. */
function hintFor(kind: ApiFailureKind, status: number | null): string {
  switch (kind) {
    case 'denied':
      return 'Si necesita este acceso, pida a jefatura que revise su permiso.';
    case 'not_found':
      return 'Revise el dato buscado e intente de nuevo.';
    case 'validation':
      return 'Corrija el campo señalado e intente de nuevo.';
    case 'conflict':
      return 'Verifique que el registro no esté duplicado.';
    case 'transport':
      return 'Revise su conexión e intente de nuevo.';
    case 'server_error':
      return 'Espere un momento e intente de nuevo.';
    case 'contract':
      return 'Intente de nuevo en un momento.';
    case 'untyped_server_error':
      return status === 500
        ? 'Espere un momento e intente de nuevo.'
        : 'Espere un momento e intente de nuevo.';
    case 'client':
      return '';
    default:
      return 'Intente de nuevo en un momento.';
  }
}

/**
 * Classifies anything a call may have thrown. An unknown throw is preserved as
 * text (an error message is not tenant data) but never as a structured field.
 */
export function classifyApiError(error: unknown): ApiFailure {
  if (error instanceof ApiRequestError) {
    const kind =
      error.code === 'api.contract_mismatch'
        ? 'contract'
        : classifyStatus(error.status, error.code);
    return {
      kind,
      status: error.status,
      code: error.code,
      reason: error.reason ?? null,
      traceId: error.traceId,
      message: messageFor(kind),
      hint: hintFor(kind, error.status),
    };
  }
  if (error instanceof Error) return fromError(error);
  return {
    kind: 'unexpected',
    status: null,
    code: 'unknown.error',
    reason: null,
    traceId: null,
    message: 'Fallo desconocido.',
    hint: hintFor('unexpected', null),
  };
}

/** `true` when the failure is the mirror of a `role.denied` route denial. */
export function failureIsDenied(failure: ApiFailure): boolean {
  return failure.kind === 'denied' && failure.code === 'access.denied';
}

/**
 * `true` for the untyped 500 of the known base gap: the API answered 500 with a
 * body that is not its own envelope, so the screen can offer the typed empty
 * state instead of an error wall.
 */
export function failureIsUntypedServerError(failure: ApiFailure): boolean {
  return failure.kind === 'untyped_server_error';
}
