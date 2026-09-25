// API client tests — the transport contract the whole UI depends on.
//
// `fetch` is replaced per test, so nothing here touches the network. The
// assertions are about the two things that break silently in practice: which
// headers actually leave the browser, and whether a refusal keeps its `code`,
// `reason` and `traceId` instead of degrading into a generic error.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { z } from 'zod';

import {
  ApiRequestError,
  newIdempotencyKey,
  proxyRequest,
  proxyUrl,
  requestJson,
  requestVoid,
  transportError,
} from '../lib/api-client.ts';
import { isApiErrorPayload, parseApiError, resolveTraceId } from '../lib/http.ts';
import { IDEMPOTENCY_KEY_HEADER, PROXY_BASE_PATH, TRACE_ID_HEADER } from '../lib/config.ts';

const originalFetch = globalThis.fetch;

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Installs a fetch stub that records the call and answers with `response`. */
function stubFetch(response: Response): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('proxyUrl coloca toda llamada bajo el proxy del mismo origen', () => {
  assert.equal(proxyUrl('/salud/patients'), `${PROXY_BASE_PATH}/salud/patients`);
  assert.equal(proxyUrl('salud/patients'), `${PROXY_BASE_PATH}/salud/patients`);
});

test('proxyRequest no adjunta Authorization: el token vive en el proxy', async () => {
  const { calls } = stubFetch(jsonResponse([]));
  await proxyRequest('/salud/patients');

  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, `${PROXY_BASE_PATH}/salud/patients`);
  const headers = headersOf(call.init);
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(call.init?.credentials, 'same-origin');
  assert.ok((headers.get(TRACE_ID_HEADER) ?? '').startsWith('web-'));
});

test('proxyRequest reenvía Idempotency-Key y x-trace-id cuando se indican', async () => {
  const { calls } = stubFetch(jsonResponse({ ok: true }));
  await proxyRequest('/billing/invoices/issue', {
    method: 'POST',
    body: { total: 59 },
    idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    traceId: 'trace-fijo-1',
  });

  const headers = headersOf(calls[0]?.init);
  assert.equal(headers.get(IDEMPOTENCY_KEY_HEADER), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(headers.get(TRACE_ID_HEADER), 'trace-fijo-1');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, JSON.stringify({ total: 59 }));
});

test('newIdempotencyKey produce un uuid distinto por intención', () => {
  const first = newIdempotencyKey();
  const second = newIdempotencyKey();
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test('requestJson valida el cuerpo con el esquema del contrato', async () => {
  const schema = z.object({ id: z.string(), total: z.number() });
  stubFetch(jsonResponse({ id: 'a', total: 59 }));
  const parsed = await requestJson('/billing/invoices/1', schema);
  assert.deepEqual(parsed, { id: 'a', total: 59 });
});

test('requestJson falla con api.contract_mismatch ante un cuerpo inesperado', async () => {
  const schema = z.object({ id: z.string(), total: z.number() });
  stubFetch(jsonResponse({ id: 'a', total: 'cincuenta' }, 200, { [TRACE_ID_HEADER]: 'trace-1' }));

  await assert.rejects(
    () => requestJson('/billing/invoices/1', schema),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'api.contract_mismatch');
      assert.equal(error.status, 200);
      assert.equal(error.traceId, 'trace-1');
      assert.match(error.reason ?? '', /total/);
      return true;
    },
  );
});

test('requestJson conserva code, reason y traceId de una denegación', async () => {
  stubFetch(
    jsonResponse(
      {
        code: 'access.denied',
        message: 'Access denied: role.denied',
        reason: 'role.denied',
        traceId: 'trace-api-9',
      },
      403,
      { [TRACE_ID_HEADER]: 'trace-api-9' },
    ),
  );

  await assert.rejects(
    () => requestJson('/salud/patients', z.array(z.unknown())),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.name, 'ApiRequestError');
      assert.equal(error.status, 403);
      assert.deepEqual(error.toDenial(), {
        code: 'access.denied',
        reason: 'role.denied',
        traceId: 'trace-api-9',
      });
      return true;
    },
  );
});

test('requestJson tipifica una respuesta que no es envelope', async () => {
  stubFetch(new Response('<html>502</html>', { status: 502 }));
  await assert.rejects(
    () => requestJson('/salud/patients', z.array(z.unknown())),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'api.unexpected_response');
      assert.equal(error.status, 502);
      return true;
    },
  );
});

test('requestJson devuelve null cuando el cuerpo está vacío', async () => {
  stubFetch(new Response(null, { status: 204 }));
  const parsed = await requestJson('/billing/invoices/1/void', z.unknown(), { method: 'POST' });
  assert.equal(parsed, null);
});

test('requestVoid acepta un 204 y rechaza un 403', async () => {
  stubFetch(new Response(null, { status: 204 }));
  await requestVoid('/billing/invoices/1/void', { method: 'POST' });

  stubFetch(jsonResponse({ code: 'duplicate', message: 'Duplicado', traceId: 't-2' }, 409));
  await assert.rejects(
    () => requestVoid('/billing/invoices/issue', { method: 'POST' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'duplicate');
      return true;
    },
  );
});

test('transportError reporta proxy.unavailable con la traza recibida', () => {
  const error = transportError('trace-x', 'ECONNREFUSED');
  assert.equal(error.code, 'proxy.unavailable');
  assert.equal(error.status, 502);
  assert.equal(error.traceId, 'trace-x');
});

test('http: parseApiError y resolveTraceId leen el envelope', () => {
  const parsed = parseApiError({
    code: 'tenant.missing',
    message: 'Sin tenant',
    traceId: 'trace-4',
  });
  assert.equal(parsed?.code, 'tenant.missing');
  assert.equal(isApiErrorPayload({ code: 'x' }), false);

  const headers = new Headers({ [TRACE_ID_HEADER]: 'trace-header' });
  assert.equal(resolveTraceId(headers, parsed), 'trace-header');
  assert.equal(resolveTraceId(new Headers(), parsed), 'trace-4');
  assert.equal(resolveTraceId(new Headers()), undefined);
});
