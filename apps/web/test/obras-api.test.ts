// Obras client tests — the path, the verb and the replay key of every call.
//
// `fetch` is replaced per test, so nothing here touches the network or a real
// API. What is asserted is the three things that break a construction flow
// silently:
//
//   1. the *path and verb* of each endpoint (a wrong segment 404s, and a wrong
//      verb turns a mutation into a read that "succeeds" without writing);
//   2. the *replay-key policy* — reads never carry `Idempotency-Key`, mutations
//      carry a fresh one per user intent, and the two CSV importers carry the
//      SHA-256 of the file bytes because that is the key the API derives for
//      itself (§5.4);
//   3. the *local pre-flight* — an invalid body is refused in the browser, with
//      no request leaving it at all.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { IDEMPOTENCY_KEY_HEADER, PROXY_BASE_PATH } from '../lib/config.ts';
import {
  addAssetReading,
  approveAttendance,
  assignAsset,
  assignWorker,
  closeAssignment,
  createBudgetLine,
  createMilestone,
  createSiteLog,
  createStockItem,
  fetchObrasImportErrorsCsv,
  getCompanyBoard,
  getImportJob,
  getSite,
  getSiteBoard,
  importAssetsCsv,
  importWorkersCsv,
  listAssets,
  listAttendance,
  listInventoryItems,
  listProgressEntries,
  listSiteLogs,
  listSiteStaff,
  listSites,
  listStockMoves,
  markAttendance,
  postProgressEntry,
  postStockMove,
  publishSiteLog,
  registerAsset,
  retireAsset,
  reverseStockMove,
  setAssetMaintenance,
} from '../lib/obras-api.ts';

const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';

const originalFetch = globalThis.fetch;

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Installs a fetch stub answering every call with the same body. */
function stubFetch(body: unknown, status = 200): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

/** Installs a fetch stub that records the call and always fails the request. */
function stubReject(): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({ code: 'test.stop', message: 'alto', traceId: 'trace-test' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { calls };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

/** A minimal valid site row, so a `readOne` endpoint passes its schema. */
function siteBody(): unknown {
  return {
    id: SITE,
    tenantId: TENANT,
    orgNodeId: SITE,
    code: 'OB-001',
    name: 'Obra de prueba',
    clientName: 'Cliente sintético',
    budgetTotal: 1000,
    startedAt: null,
    endedAt: null,
    status: 'active',
  };
}

/** A minimal valid site board, so the board read passes its schema. */
function siteBoardBody(): unknown {
  return {
    siteId: SITE,
    siteCode: 'OB-001',
    orgNodeId: SITE,
    date: '2026-09-25',
    progress: [],
    attendance: { date: '2026-09-25', registered: 0, approved: 0, rejected: 0, adjusted: 0, total: 0 },
    criticalStock: [],
    maintenanceAssets: [],
    upcomingMilestones: [],
  };
}

/** A minimal valid company board. */
function companyBoardBody(): unknown {
  return {
    orgNodeId: SITE,
    date: '2026-09-25',
    sites: { total: 0, active: 0, planned: 0, closed: 0 },
    progress: { qtyPlanned: 0, qtyDone: 0, qtyRemaining: 0, percent: 0 },
    notApplicable: {
      collections: 'No aplica en MVP1.',
      moduleUsage: 'No aplica en MVP1.',
    },
  };
}

/** A minimal valid import job, with or without an errors CSV. */
function importJobBody(errorsCsv: string | null): unknown {
  return {
    id: SITE,
    tenantId: TENANT,
    kind: 'workers_csv',
    status: 'completed',
    rowsOk: 1,
    rowsError: errorsCsv === null ? 0 : 1,
    fileId: null,
    fileSha256: null,
    errorsFileId: null,
    errorsCsv,
    createdAt: '2026-09-25T12:00:00.000Z',
  };
}

function sha256HexOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('lecturas de obras: ruta /api/proxy/obras/... en GET y sin Idempotency-Key', async () => {
  const { calls } = stubFetch([]);
  await listSites();
  await listSiteStaff(SITE);
  await listAttendance({ site: SITE, date: '2026-09-25' });
  await listProgressEntries({ site: SITE });
  await listSiteLogs(SITE);
  await listAssets();
  await listInventoryItems();
  await listStockMoves();

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${PROXY_BASE_PATH}/obras/sites`,
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/staff`,
      `${PROXY_BASE_PATH}/obras/attendance?site=${SITE}&date=2026-09-25`,
      `${PROXY_BASE_PATH}/obras/progress/entries?site=${SITE}`,
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/logs`,
      `${PROXY_BASE_PATH}/obras/assets`,
      `${PROXY_BASE_PATH}/obras/stock/items`,
      `${PROXY_BASE_PATH}/obras/stock/moves`,
    ],
  );
  for (const call of calls) {
    assert.equal(call.init?.method, 'GET');
    assert.equal(headersOf(call.init).get(IDEMPOTENCY_KEY_HEADER), null);
  }
});

test('lecturas de un registro: ficha, tableros y job por identificador', async () => {
  const { calls } = stubReject();
  await assert.rejects(async () => getSite(SITE));
  await assert.rejects(async () => getSiteBoard(SITE, { date: '2026-09-25' }));
  await assert.rejects(async () => getCompanyBoard());
  await assert.rejects(async () => getImportJob(SITE));

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${PROXY_BASE_PATH}/obras/sites/${SITE}`,
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/board?date=2026-09-25`,
      `${PROXY_BASE_PATH}/obras/board`,
      `${PROXY_BASE_PATH}/obras/imports/${SITE}`,
    ],
  );
  for (const call of calls) assert.equal(call.init?.method, 'GET');
});

test('la ruta de un tablero omite el día cuando no se indica (el API usa hoy UTC)', async () => {
  const { calls } = stubReject();
  await assert.rejects(async () => getSiteBoard(SITE));
  assert.equal(calls[0]?.url, `${PROXY_BASE_PATH}/obras/sites/${SITE}/board`);
});

test('cuerpo válido: los tableros se validan con su contrato y devuelven el registro', async () => {
  stubFetch(siteBoardBody());
  const board = await getSiteBoard(SITE, { date: '2026-09-25' });
  assert.equal(board.siteId, SITE);
  assert.equal(board.date, '2026-09-25');

  stubFetch(companyBoardBody());
  const company = await getCompanyBoard();
  assert.equal(company.orgNodeId, SITE);
  assert.equal(company.notApplicable.collections, 'No aplica en MVP1.');

  stubFetch(siteBody());
  const site = await getSite(SITE);
  assert.equal(site.code, 'OB-001');
});

test('mutaciones de obras: POST con clave fresca por intención', async () => {
  const { calls } = stubReject();
  await assert.rejects(async () => assignWorker(SITE, { userId: OTHER, roleInSite: 'capataz' }));
  await assert.rejects(async () => closeAssignment(SITE, OTHER));
  await assert.rejects(async () => markAttendance({ siteId: SITE }));
  await assert.rejects(async () => approveAttendance(SITE));
  await assert.rejects(async () => registerAsset({ orgNodeId: SITE, code: 'EQ-1', kind: 'mezcladora', serial: 'S-1' }));
  await assert.rejects(async () => assignAsset(OTHER, { siteId: SITE }));
  await assert.rejects(async () => setAssetMaintenance(OTHER));
  await assert.rejects(async () => retireAsset(OTHER));
  await assert.rejects(async () => addAssetReading(OTHER, { kind: 'horometro', value: 10 }));
  await assert.rejects(async () => createStockItem({ sku: 'SKU-1', name: 'Cemento', unit: 'bolsa' }));
  await assert.rejects(async () => postStockMove({ itemId: OTHER, warehouseNodeId: SITE, qty: 1, kind: 'out' }));
  await assert.rejects(async () => reverseStockMove(OTHER));
  await assert.rejects(async () => createBudgetLine({ siteId: SITE, description: 'Excavación' }));
  await assert.rejects(async () => postProgressEntry({ siteId: SITE, qtyDone: 5 }));
  await assert.rejects(async () => createMilestone({ siteId: SITE, name: 'Hito', dueAt: '2026-10-01T00:00:00.000Z' }));
  await assert.rejects(async () => createSiteLog(SITE, { text: 'avance del día' }));
  await assert.rejects(async () => publishSiteLog(SITE, OTHER));

  const keys = calls.map((call) => headersOf(call.init).get(IDEMPOTENCY_KEY_HEADER));
  for (const call of calls) assert.equal(call.init?.method, 'POST');
  for (const key of keys) assert.match(String(key), /^[0-9a-f-]{36}$/);
  // One key per intent: 17 distinct calls, 17 distinct keys.
  assert.equal(new Set(keys).size, calls.length);

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/staff`,
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/staff/${OTHER}/close`,
      `${PROXY_BASE_PATH}/obras/attendance`,
      `${PROXY_BASE_PATH}/obras/attendance/${SITE}/approve`,
      `${PROXY_BASE_PATH}/obras/assets`,
      `${PROXY_BASE_PATH}/obras/assets/${OTHER}/assign`,
      `${PROXY_BASE_PATH}/obras/assets/${OTHER}/maintenance`,
      `${PROXY_BASE_PATH}/obras/assets/${OTHER}/retire`,
      `${PROXY_BASE_PATH}/obras/assets/${OTHER}/readings`,
      `${PROXY_BASE_PATH}/obras/stock/items`,
      `${PROXY_BASE_PATH}/obras/stock/moves`,
      `${PROXY_BASE_PATH}/obras/stock/moves/${OTHER}/reverse`,
      `${PROXY_BASE_PATH}/obras/progress/budget-lines`,
      `${PROXY_BASE_PATH}/obras/progress/entries`,
      `${PROXY_BASE_PATH}/obras/progress/milestones`,
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/logs`,
      `${PROXY_BASE_PATH}/obras/sites/${SITE}/logs/${OTHER}/publish`,
    ],
  );
});

test('la marca de asistencia nunca envía userId: el sujeto lo resuelve el API', async () => {
  const { calls } = stubReject();
  await assert.rejects(async () => markAttendance({ siteId: SITE }));
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, { siteId: SITE, source: 'web' });
  assert.equal('userId' in body, false);
});

test('identificadores: cada segmento se codifica y la ruta no escapa del proxy', async () => {
  const { calls } = stubReject();
  await assert.rejects(async () => getSite('../../admin'));
  assert.equal(calls[0]?.url, `${PROXY_BASE_PATH}/obras/sites/..%2F..%2Fadmin`);
});

test('pre-vuelo local: un cuerpo inválido se rechaza sin ninguna solicitud', async () => {
  const { calls } = stubFetch([]);
  await assert.rejects(async () => markAttendance({ siteId: 'no-es-uuid' }));
  await assert.rejects(async () => createStockItem({ sku: '', name: 'x', unit: 'u' }));
  await assert.rejects(async () => postStockMove({ itemId: OTHER, warehouseNodeId: SITE, qty: 0, kind: 'out' }));
  assert.deepEqual(calls, []);
});

test('importación CSV: la clave de repetición es el SHA-256 del archivo', async () => {
  const csv = 'name,email,role\nAna,ana@example.test,trabajador\n';
  const { calls } = stubReject();
  await assert.rejects(async () => importWorkersCsv({ orgNodeId: SITE, csv }));
  await assert.rejects(async () => importAssetsCsv({ orgNodeId: SITE, csv }));

  assert.deepEqual(
    calls.map((call) => call.url),
    [`${PROXY_BASE_PATH}/obras/imports/workers`, `${PROXY_BASE_PATH}/obras/imports/assets`],
  );
  // Both importers send the same digest: the bytes are the identity of the load,
  // so a re-upload of the same file collapses into the original job.
  for (const call of calls) {
    assert.equal(headersOf(call.init).get(IDEMPOTENCY_KEY_HEADER), sha256HexOf(csv));
  }
});

test('descarga de errores: nombre desde content-disposition y CSV del detalle', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(importJobBody('fila,error\n2,dni inválido\n')), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': "attachment; filename*=UTF-8''errores%20obras.csv",
      },
    })) as typeof fetch;

  const download = await fetchObrasImportErrorsCsv(SITE);
  assert.deepEqual(download, {
    filename: 'errores obras.csv',
    csv: 'fila,error\n2,dni inválido\n',
  });
});

test('descarga de errores: una corrida limpia no ofrece botón', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(importJobBody(null)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  assert.equal(await fetchObrasImportErrorsCsv(SITE), null);
});
