// Client cache tests — the TTL, the stale-on-read rule and the key shape.
//
// Two things are worth testing here and nothing else is: that a cached screen is
// served for exactly its lifetime and never a millisecond longer, and that a key
// describes only the read it belongs to. The `now` argument is what makes both
// deterministic — the cache never reads the clock behind the caller's back.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CompanyBoard, SaludDashboardBoard, SiteBoard } from '@rizoma/contracts';
import { BOARD_CACHE_TTL_MS, createBoardCache } from '../lib/board-cache.ts';
import {
  boardCacheKey,
  clearBoardCache,
  readBoardCache,
  writeBoardCache,
} from '../lib/salud-board-cache.ts';
import {
  clearObrasBoardCache,
  companyBoardCacheKey,
  lastCompanyBoardScope,
  readCompanyBoardCache,
  readSiteBoardCache,
  siteBoardCacheKey,
  writeCompanyBoardCache,
  writeSiteBoardCache,
} from '../lib/obras-board-cache.ts';

const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-09-25';

test('board-cache: sirve el valor dentro del TTL y lo descarta al vencer', () => {
  const cache = createBoardCache<number>(60_000);
  cache.write('k', 7, 0);

  assert.equal(cache.read('k', 0), 7);
  assert.equal(cache.read('k', 59_999), 7);
  // The boundary is inclusive: at exactly the TTL the entry is still served.
  assert.equal(cache.read('k', 60_000), 7);
  assert.equal(cache.read('k', 60_001), null);
  // A miss on a stale entry drops it, so the map cannot grow with the session.
  assert.equal(cache.size(), 0);
});

test('board-cache: una clave ausente es un miss, no un valor indefinido', () => {
  const cache = createBoardCache<string>();
  assert.equal(cache.read('nunca-escrita', 0), null);
  cache.write('a', 'uno', 10);
  cache.write('b', 'dos', 10);
  assert.equal(cache.size(), 2);
  cache.clear('a');
  assert.equal(cache.read('a', 10), null);
  assert.equal(cache.read('b', 10), 'dos');
  cache.clear();
  assert.equal(cache.size(), 0);
});

test('board-cache: un TTL inválido cae al default en lugar de vaciar la caché', () => {
  for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const cache = createBoardCache<string>(invalid);
    cache.write('k', 'v', 0);
    assert.equal(cache.read('k', BOARD_CACHE_TTL_MS), 'v', `ttl inválido: ${invalid}`);
    assert.equal(cache.read('k', BOARD_CACHE_TTL_MS + 1), null, `ttl inválido: ${invalid}`);
  }
});

/** A minimal valid recepcion board, the shape the API echoes back. */
function recepcionBoard(orgNodeId: string, date: string): SaludDashboardBoard {
  return {
    role: 'recepcion',
    orgNodeId,
    date,
    todayAppointments: 3,
    waitingAvgMin: 12.5,
    noShows: 0,
    queue: 1,
  };
}

/** A minimal valid site board. */
function siteBoard(siteId: string, date: string): SiteBoard {
  return {
    siteId,
    siteCode: 'OB-001',
    orgNodeId: siteId,
    date,
    progress: [],
    attendance: { date, registered: 0, approved: 0, rejected: 0, adjusted: 0, total: 0 },
    criticalStock: [],
    maintenanceAssets: [],
    upcomingMilestones: [],
  };
}

/** A minimal valid company board. */
function companyBoard(orgNodeId: string, date: string): CompanyBoard {
  return {
    orgNodeId,
    date,
    sites: { total: 1, active: 1, planned: 0, closed: 0 },
    progress: { qtyPlanned: 10, qtyDone: 4, qtyRemaining: 6, percent: 40 },
    notApplicable: { collections: 'No aplica.', moduleUsage: 'No aplica.' },
  };
}

test('salud: la clave del tablero es rol|sede|día y se escribe con la identidad eco', () => {
  clearBoardCache();
  assert.equal(boardCacheKey('caja', SITE, DAY), `caja|${SITE}|${DAY}`);

  writeBoardCache(recepcionBoard(SITE, DAY), 1_000);
  assert.deepEqual(readBoardCache('recepcion', SITE, DAY, 1_000), recepcionBoard(SITE, DAY));
  // Another role, another sede or another day is another read.
  assert.equal(readBoardCache('caja', SITE, DAY, 1_000), null);
  assert.equal(readBoardCache('recepcion', OTHER, DAY, 1_000), null);
  assert.equal(readBoardCache('recepcion', SITE, '2026-09-26', 1_000), null);
  clearBoardCache();
});

test('obras: tablero de obra y de empresa no comparten entradas', () => {
  clearObrasBoardCache();
  assert.equal(siteBoardCacheKey(SITE, DAY), `site|${SITE}|${DAY}`);
  assert.equal(companyBoardCacheKey(SITE, DAY), `company|${SITE}|${DAY}`);

  writeSiteBoardCache(siteBoard(SITE, DAY), 1_000);
  writeCompanyBoardCache(companyBoard(SITE, DAY), 1_000);

  assert.deepEqual(readSiteBoardCache(SITE, DAY, 1_000), siteBoard(SITE, DAY));
  assert.deepEqual(readCompanyBoardCache(SITE, DAY, 1_000), companyBoard(SITE, DAY));
  assert.equal(readSiteBoardCache(SITE, '2026-09-26', 1_000), null);
  assert.equal(readCompanyBoardCache(OTHER, DAY, 1_000), null);
  clearObrasBoardCache();
});

test('obras: la identidad del último tablero de empresa sale de la respuesta', () => {
  clearObrasBoardCache();
  // Nothing to remember before the first answer.
  assert.equal(lastCompanyBoardScope(), null);

  writeCompanyBoardCache(companyBoard(SITE, DAY), 1_000);
  assert.deepEqual(lastCompanyBoardScope(), { orgNodeId: SITE, date: DAY });

  writeCompanyBoardCache(companyBoard(OTHER, '2026-09-26'), 2_000);
  assert.deepEqual(lastCompanyBoardScope(), { orgNodeId: OTHER, date: '2026-09-26' });

  clearObrasBoardCache();
  assert.equal(lastCompanyBoardScope(), null);
  assert.equal(readSiteBoardCache(SITE, DAY, 2_000), null);
  assert.equal(readCompanyBoardCache(SITE, DAY, 2_000), null);
});

test('obras: una entrada vencida deja de servirse también en los tableros', () => {
  clearObrasBoardCache();
  writeSiteBoardCache(siteBoard(SITE, DAY), 0);
  assert.deepEqual(readSiteBoardCache(SITE, DAY, BOARD_CACHE_TTL_MS), siteBoard(SITE, DAY));
  assert.equal(readSiteBoardCache(SITE, DAY, BOARD_CACHE_TTL_MS + 1), null);
  clearObrasBoardCache();
});
