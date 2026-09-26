// P2 list wrappers — route, verb and query coverage for the pickers the
// screens use instead of a pasted UUID: org nodes, users, cash sessions and
// import jobs. Same stub-fetch precedent as `obras-api.test.ts`: every call
// answers `[]`, so the test pins the wire shape, never the payload.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { PROXY_BASE_PATH } from '../lib/config.ts';
import { listImportJobs } from '../lib/imports-api.ts';
import { listOrgNodes } from '../lib/org-api.ts';
import { listCashSessions } from '../lib/salud-api.ts';
import { listUsers } from '../lib/users-api.ts';

const SITE = '11111111-1111-4111-8111-111111111111';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('lecturas P2: sedes, personas, turnos y jobs van por /api/proxy en GET', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    assert.equal(init?.method, 'GET');
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await listOrgNodes({ kind: 'sede' });
  await listUsers({ orgNodeId: SITE });
  await listUsers({ role: 'medico' });
  await listCashSessions({ status: 'open' });
  await listImportJobs({ kind: 'workers' });
  await listImportJobs({ kind: 'workers', status: 'completed' });
  // Unset filters travel nowhere: the picker scope is the whole list.
  await listOrgNodes();
  await listUsers();

  assert.deepEqual(calls, [
    `${PROXY_BASE_PATH}/org/nodes?kind=sede`,
    `${PROXY_BASE_PATH}/users?orgNodeId=${SITE}`,
    `${PROXY_BASE_PATH}/users?role=medico`,
    `${PROXY_BASE_PATH}/billing/cash-sessions?status=open`,
    `${PROXY_BASE_PATH}/imports/jobs?kind=workers`,
    `${PROXY_BASE_PATH}/imports/jobs?kind=workers&status=completed`,
    `${PROXY_BASE_PATH}/org/nodes`,
    `${PROXY_BASE_PATH}/users`,
  ]);
});
