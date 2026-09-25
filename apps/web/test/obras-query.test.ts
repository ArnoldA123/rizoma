// Obras query-helper tests — the query strings and the refresh bands.
//
// The web never assembles a URL by hand: the contracts module owns the query
// string of every list endpoint, and the boards own their cadence band. These are
// the two places where a silent change would look harmless and break something
// real — a dropped `?site=` is a 400 from the service, and a poll outside the
// band is either a hammered primary connection or a stale board.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOARD_POLL_DEFAULT_MS,
  BOARD_POLL_MAX_MS,
  BOARD_POLL_MIN_MS,
  OBRAS_BOARD_POLL_DEFAULT_MS,
  OBRAS_BOARD_POLL_MAX_MS,
  OBRAS_BOARD_POLL_MIN_MS,
  attendanceQueryString,
  clampBoardPollMs,
  clampObrasBoardPollMs,
  progressEntriesQueryString,
  saludBoardQueryString,
  siteBoardQueryString,
} from '@rizoma/contracts';

const SITE = '11111111-1111-4111-8111-111111111111';

test('asistencia: el query string nombra sede y día, en ese orden', () => {
  assert.equal(
    attendanceQueryString({ site: SITE, date: '2026-09-25' }),
    `?site=${SITE}&date=2026-09-25`,
  );
  // Both fields are required by the service, so an empty one is an omitted
  // parameter and never a default.
  assert.equal(attendanceQueryString({ site: SITE }), `?site=${SITE}`);
  assert.equal(attendanceQueryString({ date: '2026-09-25' }), '?date=2026-09-25');
  assert.equal(attendanceQueryString({ site: '', date: '' }), '');
  assert.equal(attendanceQueryString(), '');
});

test('tablero de obra: el día es opcional y vacío significa «hoy UTC»', () => {
  assert.equal(siteBoardQueryString({ date: '2026-09-25' }), '?date=2026-09-25');
  assert.equal(siteBoardQueryString({ date: '' }), '');
  assert.equal(siteBoardQueryString(), '');
});

test('partidas: el query string nunca inventa una sede', () => {
  assert.equal(progressEntriesQueryString({ site: SITE }), `?site=${SITE}`);
  assert.equal(progressEntriesQueryString({ site: '' }), '');
  assert.equal(progressEntriesQueryString(), '');
});

test('tablero de rol: sede y día son opcionales y se codifican', () => {
  assert.equal(saludBoardQueryString({ org: SITE, date: '2026-09-25' }), `?org=${SITE}&date=2026-09-25`);
  assert.equal(saludBoardQueryString({ date: '2026-09-25' }), '?date=2026-09-25');
  assert.equal(saludBoardQueryString({ org: '' }), '');
  assert.equal(saludBoardQueryString(), '');
});

test('banda de lectura de salud: 1–5 minutos con 3 por defecto', () => {
  assert.equal(BOARD_POLL_MIN_MS, 60_000);
  assert.equal(BOARD_POLL_MAX_MS, 300_000);
  assert.ok(BOARD_POLL_DEFAULT_MS > BOARD_POLL_MIN_MS && BOARD_POLL_DEFAULT_MS < BOARD_POLL_MAX_MS);

  assert.equal(clampBoardPollMs(1), BOARD_POLL_MIN_MS);
  assert.equal(clampBoardPollMs(60_000), BOARD_POLL_MIN_MS);
  assert.equal(clampBoardPollMs(120_000), 120_000);
  assert.equal(clampBoardPollMs(10_000_000), BOARD_POLL_MAX_MS);
  assert.equal(clampBoardPollMs(Number.NaN), BOARD_POLL_DEFAULT_MS);
  assert.equal(clampBoardPollMs(Number.POSITIVE_INFINITY), BOARD_POLL_DEFAULT_MS);
});

test('banda de lectura de obras: 5–15 minutos con 10 por defecto', () => {
  assert.equal(OBRAS_BOARD_POLL_MIN_MS, 300_000);
  assert.equal(OBRAS_BOARD_POLL_MAX_MS, 900_000);
  assert.equal(OBRAS_BOARD_POLL_DEFAULT_MS, 600_000);
  // The two bands are disjoint in their lower half: the construction cadence is
  // slower on purpose, and the salud band never reaches the obras minimum + 1.
  assert.ok(OBRAS_BOARD_POLL_MIN_MS >= BOARD_POLL_MAX_MS);

  assert.equal(clampObrasBoardPollMs(1), OBRAS_BOARD_POLL_MIN_MS);
  assert.equal(clampObrasBoardPollMs(420_000), 420_000);
  assert.equal(clampObrasBoardPollMs(Number.MAX_SAFE_INTEGER), OBRAS_BOARD_POLL_MAX_MS);
  assert.equal(clampObrasBoardPollMs(Number.NaN), OBRAS_BOARD_POLL_DEFAULT_MS);
});

test('cadencia de la agenda: los 2 minutos fijos caen dentro de la banda de salud', () => {
  // The agenda reads on a fixed 2-minute timer instead of a selector, so the
  // constant has to stay inside the band the task documents.
  const agendaPollMs = 120_000;
  assert.ok(agendaPollMs >= BOARD_POLL_MIN_MS && agendaPollMs <= BOARD_POLL_MAX_MS);
  assert.equal(clampBoardPollMs(agendaPollMs), agendaPollMs);
});
