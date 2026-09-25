// State-transition contract tests — synthetic payloads only, no live API.
//
// These tests pin the closed B3 machine: the record schema accepts the exact
// shape the catalog reads emit, the seed mirror holds exactly the six rows
// migration 009 backfills, and the assert input refuses out-of-scope entities
// (appointments/sites) at the contract boundary.
// Runner: `node --test src/state-transitions.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertTransitionInputSchema,
  ATTENDANCE_TRANSITION_ROLES,
  ATTENDANCE_TRANSITIONS,
  EPISODE_TRANSITION_ROLES,
  EPISODE_TRANSITIONS,
  SEEDED_STATE_TRANSITIONS,
  SITE_LOG_TRANSITION_ROLES,
  SITE_LOG_TRANSITIONS,
  STATE_TRANSITION_ENTITIES,
  stateTransitionListSchema,
  stateTransitionRecordSchema,
} from './state-transitions.ts';

const TENANT = 'a9000000-0000-4000-8000-0000000000a9';
const ROW_ID = 'b9000000-0000-4000-8000-0000000000b9';

test('record schema accepts a seeded catalog row', () => {
  const row = {
    id: ROW_ID,
    tenantId: TENANT,
    entity: 'episode',
    fromStatus: 'open',
    toStatus: 'closed',
    allowedRoles: ['medico'],
    createdAt: '2026-03-02T12:00:00.000Z',
  };
  assert.deepEqual(stateTransitionRecordSchema.parse(row), row);
});

test('record schema refuses an out-of-scope entity', () => {
  const row = {
    id: ROW_ID,
    tenantId: TENANT,
    entity: 'appointment',
    fromStatus: 'scheduled',
    toStatus: 'done',
    allowedRoles: ['medico'],
    createdAt: null,
  };
  assert.throws(() => stateTransitionRecordSchema.parse(row));
});

test('seed mirror holds exactly the six tested transitions', () => {
  assert.equal(SEEDED_STATE_TRANSITIONS.length, 6);
  assert.deepEqual(
    SEEDED_STATE_TRANSITIONS.map((transition) =>
      [transition.entity, transition.from, transition.to].join(':'),
    ),
    [
      'episode:open:closed',
      'episode:open:cancelled',
      'attendance:registered:approved',
      'attendance:registered:rejected',
      'attendance:registered:adjusted',
      'site_log:draft:published',
    ],
  );
});

test('seed mirror roles match the policy matrix in force', () => {
  const byKey = new Map(
    SEEDED_STATE_TRANSITIONS.map((transition) => [
      `${transition.entity}:${transition.from}:${transition.to}`,
      transition.allowedRoles,
    ]),
  );
  assert.deepEqual(byKey.get('episode:open:closed'), [...EPISODE_TRANSITION_ROLES]);
  assert.deepEqual(byKey.get('episode:open:cancelled'), [...EPISODE_TRANSITION_ROLES]);
  assert.deepEqual(byKey.get('attendance:registered:approved'), [...ATTENDANCE_TRANSITION_ROLES]);
  assert.deepEqual(byKey.get('site_log:draft:published'), [...SITE_LOG_TRANSITION_ROLES]);
});

test('per-entity catalogs cover the seed without extras', () => {
  assert.deepEqual(
    EPISODE_TRANSITIONS.map((transition) => `episode:${transition.from}:${transition.to}`),
    ['episode:open:closed', 'episode:open:cancelled'],
  );
  assert.deepEqual(
    ATTENDANCE_TRANSITIONS.map((transition) => `attendance:${transition.from}:${transition.to}`),
    [
      'attendance:registered:approved',
      'attendance:registered:rejected',
      'attendance:registered:adjusted',
    ],
  );
  assert.deepEqual(
    SITE_LOG_TRANSITIONS.map((transition) => `site_log:${transition.from}:${transition.to}`),
    ['site_log:draft:published'],
  );
  assert.deepEqual([...STATE_TRANSITION_ENTITIES], ['episode', 'attendance', 'site_log']);
});

test('list schema accepts the whole seed as rows', () => {
  const rows = SEEDED_STATE_TRANSITIONS.map((transition, index) => ({
    id: `c9000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    tenantId: TENANT,
    entity: transition.entity,
    fromStatus: transition.from,
    toStatus: transition.to,
    allowedRoles: [...transition.allowedRoles],
    createdAt: null,
  }));
  assert.equal(stateTransitionListSchema.parse(rows).length, 6);
});

test('assert input accepts a move and refuses out-of-scope entities', () => {
  assert.deepEqual(
    assertTransitionInputSchema.parse({
      entity: 'attendance',
      from: 'registered',
      to: 'approved',
      role: 'capataz',
    }),
    { entity: 'attendance', from: 'registered', to: 'approved', role: 'capataz' },
  );
  assert.throws(() =>
    assertTransitionInputSchema.parse({
      entity: 'site',
      from: 'active',
      to: 'closed',
      role: 'gerente',
    }),
  );
  assert.throws(() =>
    assertTransitionInputSchema.parse({ entity: 'episode', from: '', to: 'closed', role: 'medico' }),
  );
});
