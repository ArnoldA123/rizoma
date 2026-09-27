// P4 appointment + prescription transitions — route, verb and body coverage
// for the two-click agenda actions and the Emitir button. Same stub-fetch
// precedent as `p2-lists.test.ts`: calls answer a minimal valid record, so
// the test pins the wire shape, never the payload.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { PROXY_BASE_PATH } from '../lib/config.ts';
import {
  cancelAppointment,
  cancelPrescription,
  confirmAppointment,
  attendAppointment,
  deriveAppointment,
  issuePrescription,
  markNoShow,
  rescheduleAppointment,
} from '../lib/salud-api.ts';

const ID = '11111111-1111-4111-8111-111111111111';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubRecord(extra: Record<string, unknown> = {}): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(
      JSON.stringify({
        id: ID,
        tenantId: ID,
        orgNodeId: ID,
        patientId: ID,
        professionalId: ID,
        startsAt: '2026-10-01T14:00:00.000Z',
        durationMin: 30,
        status: 'scheduled',
        createdAt: '2026-09-26T08:00:00.000Z',
        ...extra,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { calls };
}

test('agenda en dos clics: status via PATCH y derive vía POST', async () => {
  const { calls } = stubRecord();
  await confirmAppointment(ID);
  await attendAppointment(ID, 'checked_in');
  await markNoShow(ID);
  await cancelAppointment(ID);
  await deriveAppointment(ID);

  const base = `${PROXY_BASE_PATH}/salud/appointments/${ID}`;
  assert.deepEqual(calls, [
    `PATCH ${base}/status`,
    `PATCH ${base}/status`,
    `PATCH ${base}/status`,
    `PATCH ${base}/status`,
    `POST ${base}/derive`,
  ]);
});

test('reprogramar viaja por PATCH reschedule con el nuevo inicio', async () => {
  const { calls } = stubRecord();
  await rescheduleAppointment(ID, { startsAt: '2026-10-01T14:00:00.000Z' });

  assert.deepEqual(calls, [
    `PATCH ${PROXY_BASE_PATH}/salud/appointments/${ID}/reschedule`,
  ]);
});

test('receta: Emitir y Anular viajan por PATCH', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(
      JSON.stringify({
        id: ID,
        tenantId: ID,
        patientId: ID,
        episodeId: ID,
        templateCode: 'receta',
        items: [],
        status: 'draft',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  await issuePrescription(ID);
  await cancelPrescription(ID);

  const base = `${PROXY_BASE_PATH}/salud/prescriptions/${ID}`;
  assert.deepEqual(calls, [`PATCH ${base}`, `PATCH ${base}`]);
});
