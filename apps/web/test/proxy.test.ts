// Proxy shaping tests — the path mapping and the header precedence.
//
// These are the two rules that decide whether the proxy is a safe stand-in for
// CORS: the API version prefix must be applied exactly once and never escaped,
// and the development identity headers must lose to a real token. Both are
// asserted directly, without a server and without a network.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTHORIZATION_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  SCOPES_HEADER,
  TENANT_ID_HEADER,
  TRACE_ID_HEADER,
  USER_ID_HEADER,
} from '../lib/config.ts';
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  resolveUpstreamPath,
  sanitizeProxyPath,
} from '../lib/proxy.ts';
import { DEV_HEADERS_ENABLED } from '../lib/server-config.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

test('resolveUpstreamPath aplica el prefijo /v1 exactamente una vez', () => {
  assert.equal(resolveUpstreamPath(['salud', 'patients']), '/v1/salud/patients');
  assert.equal(
    resolveUpstreamPath(['obras', 'sites', 'abc', 'board']),
    '/v1/obras/sites/abc/board',
  );
  assert.equal(
    resolveUpstreamPath(['billing', 'invoices', 'abc', 'pay']),
    '/v1/billing/invoices/abc/pay',
  );
});

test('resolveUpstreamPath deja /health fuera del prefijo de versión', () => {
  assert.equal(resolveUpstreamPath(['health']), '/health');
  assert.equal(resolveUpstreamPath(['v1', 'health']), '/v1/v1/health');
});

test('sanitizeProxyPath rechaza segmentos que podrían escapar de la ruta', () => {
  assert.equal(sanitizeProxyPath([]), null);
  assert.equal(sanitizeProxyPath(['..']), null);
  assert.equal(sanitizeProxyPath(['salud', '..', 'admin']), null);
  assert.equal(sanitizeProxyPath(['salud', '.']), null);
  assert.equal(sanitizeProxyPath(['salud', '']), null);
  assert.equal(sanitizeProxyPath(['salud/patients']), null);
  assert.equal(sanitizeProxyPath(['salud\\patients']), null);
  assert.equal(resolveUpstreamPath(['..']), null);
  assert.deepEqual(sanitizeProxyPath(['salud', 'sa lud']), ['salud', 'sa%20lud']);
});

test('buildUpstreamHeaders: el token gana y aporta Authorization Bearer', () => {
  const headers = buildUpstreamHeaders({
    accessToken: 'token-de-prueba',
    devIdentity: { tenantId: TENANT, userId: USER, scopes: 'openid' },
    traceId: 'trace-1',
    accept: 'application/json',
  });

  assert.equal(headers.get(AUTHORIZATION_HEADER), 'Bearer token-de-prueba');
  assert.equal(headers.get(TRACE_ID_HEADER), 'trace-1');
  // Fail-closed: con token presente las cabeceras locales no viajan.
  assert.equal(headers.get(TENANT_ID_HEADER), null);
  assert.equal(headers.get(USER_ID_HEADER), null);
  assert.equal(headers.get(SCOPES_HEADER), null);
});

test('buildUpstreamHeaders reenvía Idempotency-Key sin transformarla', () => {
  const key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const headers = buildUpstreamHeaders({
    accessToken: 'token-de-prueba',
    idempotencyKey: key,
    traceId: 'trace-2',
  });
  assert.equal(headers.get(IDEMPOTENCY_KEY_HEADER), key);
});

test('buildUpstreamHeaders omite cabeceras ausentes en vez de enviarlas vacías', () => {
  const headers = buildUpstreamHeaders({ traceId: 'trace-3' });
  assert.equal(headers.get(AUTHORIZATION_HEADER), null);
  assert.equal(headers.get(IDEMPOTENCY_KEY_HEADER), null);
  assert.equal(headers.get('content-type'), null);
  assert.equal(headers.get('accept'), 'application/json');
});

test('buildUpstreamHeaders usa la identidad local solo sin token', () => {
  // `node --test` runs with NODE_ENV unset, which is the "outside production"
  // case the fallback is scoped to.
  assert.equal(DEV_HEADERS_ENABLED, true);

  const headers = buildUpstreamHeaders({
    accessToken: null,
    devIdentity: { tenantId: TENANT, userId: USER, scopes: 'openid site.read' },
    traceId: 'trace-4',
  });

  assert.equal(headers.get(TENANT_ID_HEADER), TENANT);
  assert.equal(headers.get(USER_ID_HEADER), USER);
  assert.equal(headers.get(SCOPES_HEADER), 'openid site.read');
  assert.equal(headers.get(AUTHORIZATION_HEADER), null);
});

test('copyResponseHeaders conserva tipo, descarga y traza; descarta el resto', () => {
  const upstream = new Headers({
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="errors.csv"',
    'set-cookie': 'leak=1',
    'x-powered-by': 'Express',
    [TRACE_ID_HEADER]: 'trace-api',
  });
  const outgoing = new Headers();

  copyResponseHeaders(upstream, outgoing, 'trace-fallback');

  assert.equal(outgoing.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(outgoing.get('content-disposition'), 'attachment; filename="errors.csv"');
  assert.equal(outgoing.get(TRACE_ID_HEADER), 'trace-api');
  assert.equal(outgoing.get('cache-control'), 'no-store');
  assert.equal(outgoing.get('set-cookie'), null);
  assert.equal(outgoing.get('x-powered-by'), null);
});

test('copyResponseHeaders cae a la traza propia cuando el API no la devuelve', () => {
  const outgoing = new Headers();
  copyResponseHeaders(new Headers(), outgoing, 'trace-propia');
  assert.equal(outgoing.get(TRACE_ID_HEADER), 'trace-propia');
});
