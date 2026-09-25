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
  /** Human message from the envelope, or a local neutral one. */
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

function hintFor(kind: ApiFailureKind, status: number | null): string {
  switch (kind) {
    case 'denied':
      return 'El API mantiene la decisión: su rol no habilita esta operación. El identificador de traza permite auditarla.';
    case 'not_found':
      return 'El registro no existe o quedó fuera del alcance de la organización. Revise el identificador.';
    case 'validation':
      return 'Uno de los datos enviados no cumple el contrato del API. Corrija el campo señalado y reintente.';
    case 'conflict':
      return 'Ya existe un registro con esa clave de negocio. La operación no se aplicó.';
    case 'transport':
      return 'El API no se pudo alcanzar desde el proxy. Verifique que el runtime local esté en marcha.';
    case 'server_error':
      return 'El API reportó un fallo interno con su propio envelope. Reintente y, si persiste, escale con el identificador de traza.';
    case 'contract':
      return 'La respuesta no cumple el contrato declarado. No se muestra el contenido para evitar datos incompletos.';
    case 'untyped_server_error':
      return status === 500
        ? 'El API falló antes de construir su envelope. Causa habitual en el entorno local: la identidad activa no tiene fila en memberships, y la auditoría de la denegación no puede registrar el nodo de organización. La pantalla muestra un estado vacío tipificado en lugar del cuerpo del error.'
        : 'El API respondió con un error de infraestructura. Reintente; si persiste, escale con el identificador de traza.';
    case 'client':
      return '';
    default:
      return 'Fallo no clasificado. Reintente y, si persiste, escale con el identificador de traza.';
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
      message: error.message,
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
