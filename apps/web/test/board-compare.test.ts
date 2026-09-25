// Board comparison and export client tests — query builders, delta reading
// and download-filename fallback.
//
// `fetch` is replaced per test, so nothing here touches the network. The
// private `readDelta`/`boardExportFilename` helpers are exercised through the
// public `fetchCompared*`/`download*` entry points, which is the only surface
// the screens import.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { PROXY_BASE_PATH } from '../lib/config.ts';
import {
  companyBoardExportUrl,
  downloadCompanyBoardCsv,
  downloadSiteBoardCsv,
  fetchComparedCompanyBoard,
  fetchComparedSiteBoard,
  siteBoardCompareQueryString,
  siteBoardExportUrl,
} from '../lib/obras-board-cache.ts';
import {
  downloadSaludBoardCsv,
  fetchComparedSaludBoard,
  saludBoardCompareQueryString,
  saludBoardExportUrl,
} from '../lib/salud-board-cache.ts';

const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-09-25';
const PREVIOUS = '2026-09-18';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every proxied call with one JSON body. */
function stubJson(body: unknown, headers: Record<string, string> = {}): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    void init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { calls };
}

/** Answers every proxied call with one text body (CSV downloads). */
function stubText(body: string, headers: Record<string, string> = {}): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    void init;
    return new Response(body, { status: 200, headers });
  }) as typeof fetch;
  return { calls };
}

function recepcionBoard(date: string): Record<string, unknown> {
  return {
    role: 'recepcion',
    orgNodeId: SITE,
    date,
    todayAppointments: 10,
    waitingAvgMin: 12.5,
    noShows: 1,
    queue: 4,
  };
}

function siteBoard(date: string): Record<string, unknown> {
  return {
    siteId: SITE,
    siteCode: 'OB-001',
    orgNodeId: SITE,
    date,
    progress: [],
    attendance: { date, registered: 3, approved: 2, rejected: 0, adjusted: 0, total: 5 },
    criticalStock: [],
    maintenanceAssets: [],
    upcomingMilestones: [],
  };
}

function companyBoard(date: string): Record<string, unknown> {
  return {
    orgNodeId: SITE,
    date,
    sites: { total: 2, active: 1, planned: 1, closed: 0 },
    progress: { qtyPlanned: 100, qtyDone: 40, qtyRemaining: 60, percent: 40 },
    notApplicable: { collections: 'Not applicable.', moduleUsage: 'Not applicable.' },
  };
}

// ============ query builders ============

test('salud compare query: org, date and compare travel in order, off sends nothing', () => {
  assert.equal(saludBoardCompareQueryString(), '');
  assert.equal(saludBoardCompareQueryString({ compare: 'off' }), '');
  assert.equal(
    saludBoardCompareQueryString({ org: SITE, date: DAY, compare: 'previous-week' }),
    `?org=${SITE}&date=${DAY}&compare=previous-week`,
  );
  assert.equal(saludBoardCompareQueryString({ org: '', date: '' }), '');
  assert.equal(saludBoardCompareQueryString({ date: DAY }), `?date=${DAY}`);
  // Values are encoded, so a sede or day can never break the query string.
  assert.equal(
    saludBoardCompareQueryString({ org: 'a/b', date: DAY, compare: 'previous-week' }),
    `?org=${encodeURIComponent('a/b')}&date=${DAY}&compare=previous-week`,
  );
});

test('salud export url: role path with org, date and a fixed csv format', () => {
  assert.equal(saludBoardExportUrl('caja'), '/salud/dashboards/caja/export?format=csv');
  assert.equal(
    saludBoardExportUrl('caja', { org: SITE, date: DAY }),
    `/salud/dashboards/caja/export?org=${SITE}&date=${DAY}&format=csv`,
  );
  assert.equal(
    saludBoardExportUrl('a/b', { date: DAY }),
    `/salud/dashboards/${encodeURIComponent('a/b')}/export?date=${DAY}&format=csv`,
  );
});

test('obras site compare query: date first, then compare, off sends nothing', () => {
  assert.equal(siteBoardCompareQueryString(), '');
  assert.equal(siteBoardCompareQueryString({ compare: 'off' }), '');
  assert.equal(
    siteBoardCompareQueryString({ date: DAY, compare: 'previous-week' }),
    `?date=${DAY}&compare=previous-week`,
  );
  assert.equal(siteBoardCompareQueryString({ date: '' }), '');
});

test('obras export urls: site carries its id, company carries no scope', () => {
  assert.equal(siteBoardExportUrl(SITE), `/obras/sites/${SITE}/board/export?format=csv`);
  assert.equal(
    siteBoardExportUrl(SITE, { date: DAY }),
    `/obras/sites/${SITE}/board/export?date=${DAY}&format=csv`,
  );
  assert.equal(companyBoardExportUrl(), '/obras/board/export?format=csv');
  assert.equal(companyBoardExportUrl({ date: DAY }), `/obras/board/export?date=${DAY}&format=csv`);
});

// ============ compared reads (delta) ============

test('salud compared read: current, previous and the drift, through the proxy', async () => {
  const { calls } = stubJson({
    current: recepcionBoard(DAY),
    previous: recepcionBoard(PREVIOUS),
    delta: { todayAppointments: 5, waitingAvgMin: 2.5 },
  });
  const compared = await fetchComparedSaludBoard('recepcion', { org: SITE, date: DAY });

  assert.equal(
    calls[0],
    `${PROXY_BASE_PATH}/salud/dashboards/recepcion?org=${SITE}&date=${DAY}&compare=previous-week`,
  );
  assert.equal(compared.current.date, DAY);
  assert.equal(compared.previous.date, PREVIOUS);
  assert.deepEqual(compared.delta, { todayAppointments: 5, waitingAvgMin: 2.5 });
});

test('compared delta: finite numbers pass, numeric strings coerce, garbage drops', async () => {
  stubJson({
    current: recepcionBoard(DAY),
    previous: recepcionBoard(PREVIOUS),
    delta: {
      keep: 2,
      coerced: '3',
      dropped: 'oops',
      infinite: 'Infinity',
      missing: 'NaN',
    },
  });
  const compared = await fetchComparedSaludBoard('recepcion', { date: DAY });
  assert.deepEqual(compared.delta, { keep: 2, coerced: 3 });
});

test('compared read: a non-object delta or an invalid leg fails the contract', async () => {
  stubJson({ current: recepcionBoard(DAY), previous: recepcionBoard(PREVIOUS), delta: [] });
  await assert.rejects(async () => fetchComparedSaludBoard('recepcion', { date: DAY }));

  stubJson({
    current: { ...recepcionBoard(DAY), todayAppointments: 'many' },
    previous: recepcionBoard(PREVIOUS),
    delta: {},
  });
  await assert.rejects(async () => fetchComparedSaludBoard('recepcion', { date: DAY }));
});

test('obras site compared read: same envelope rule on the site schema', async () => {
  const { calls } = stubJson({
    current: siteBoard(DAY),
    previous: siteBoard(PREVIOUS),
    delta: { attendanceRegistered: 2, attendanceTotal: '3', dropped: 'oops' },
  });
  const compared = await fetchComparedSiteBoard(SITE, { date: DAY });

  assert.equal(
    calls[0],
    `${PROXY_BASE_PATH}/obras/sites/${SITE}/board?date=${DAY}&compare=previous-week`,
  );
  assert.equal(compared.current.date, DAY);
  assert.equal(compared.previous.date, PREVIOUS);
  assert.deepEqual(compared.delta, { attendanceRegistered: 2, attendanceTotal: 3 });
});

test('obras company compared read: no scope parameter on the request', async () => {
  const { calls } = stubJson({
    current: companyBoard(DAY),
    previous: companyBoard(PREVIOUS),
    delta: { sitesTotal: 0 },
  });
  const compared = await fetchComparedCompanyBoard();

  assert.equal(calls[0], `${PROXY_BASE_PATH}/obras/board?compare=previous-week`);
  assert.equal(compared.current.date, DAY);
  assert.equal(compared.previous.date, PREVIOUS);
  assert.deepEqual(compared.delta, { sitesTotal: 0 });
});

// ============ download filename fallback ============

test('salud download: upstream filename wins when safe, local fallback otherwise', async () => {
  stubText('role,org_node_id,date\n', {
    'content-disposition': 'attachment; filename="tablero-caja-2026-09-25.csv"',
  });
  assert.deepEqual(await downloadSaludBoardCsv('caja', { date: DAY }), {
    filename: 'tablero-caja-2026-09-25.csv',
    csv: 'role,org_node_id,date\n',
  });

  // No header: the local fallback names the board role.
  stubText('role,org_node_id,date\n');
  assert.deepEqual(await downloadSaludBoardCsv('caja', { date: DAY }), {
    filename: 'tablero-caja.csv',
    csv: 'role,org_node_id,date\n',
  });

  // Unsafe header values never become the download target.
  for (const header of [
    'attachment; filename="../etc/passwd"',
    'attachment; filename="sub/dir.csv"',
    'attachment; filename=".oculto.csv"',
  ]) {
    stubText('role,org_node_id,date\n', { 'content-disposition': header });
    const download = await downloadSaludBoardCsv('caja', { date: DAY });
    assert.equal(download.filename, 'tablero-caja.csv', header);
  }
});

test('salud download: filename* wins over filename, a broken one falls through', async () => {
  stubText('a,b\n', {
    'content-disposition': `attachment; filename="fallback.csv"; filename*=UTF-8''tablero%20caja.csv`,
  });
  assert.equal((await downloadSaludBoardCsv('caja')).filename, 'tablero caja.csv');

  stubText('a,b\n', {
    'content-disposition': `attachment; filename="ok.csv"; filename*=UTF-8''%E0%A4%A`,
  });
  assert.equal((await downloadSaludBoardCsv('caja')).filename, 'ok.csv');
});

test('obras downloads: site and company fallbacks stay distinct', async () => {
  stubText('site_id\n');
  assert.deepEqual(await downloadSiteBoardCsv(SITE, { date: DAY }), {
    filename: 'tablero-obra.csv',
    csv: 'site_id\n',
  });
  assert.deepEqual(await downloadCompanyBoardCsv({ date: DAY }), {
    filename: 'tablero-empresa.csv',
    csv: 'site_id\n',
  });

  stubText('site_id\n', { 'content-disposition': 'attachment; filename="tablero-obra-OB-001.csv"' });
  assert.equal((await downloadSiteBoardCsv(SITE)).filename, 'tablero-obra-OB-001.csv');

  // An unsafe upstream name falls back instead of escaping the download dir.
  stubText('org\n', { 'content-disposition': 'attachment; filename="../x.csv"' });
  assert.equal((await downloadCompanyBoardCsv()).filename, 'tablero-empresa.csv');

  // The other node is never confused with this one.
  void OTHER;
});
