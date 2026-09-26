// P2-4a contract coverage: crews + import jobs listing schemas.
//
// Pins the shapes the last two P2 selectors consume: crews carry the crew
// name (assignment forms stop pasting a crew UUID) and import jobs carry
// kind/status/counters (lookup forms stop pasting a job UUID). Runner:
// `node --test src/crews-jobs.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  crewListSchema,
  crewPagedSchema,
  crewRecordSchema,
} from './obras-operations.ts';
import {
  importJobListSchema,
  importJobPagedSchema,
  importJobListItemSchema,
} from './imports.ts';

const CREW = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Cuadrilla Norte',
  orgNodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  active: true,
};

const JOB = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'workers',
  status: 'completed',
  rowsOk: 18,
  rowsError: 0,
  createdAt: '2026-09-26T08:00:00.000Z',
};

describe('crew schemas', () => {
  it('accepts a crew with its name resolved', () => {
    assert.deepEqual(crewRecordSchema.parse(CREW), CREW);
  });

  it('parses list and paged envelopes', () => {
    assert.deepEqual(crewListSchema.parse([CREW]), [CREW]);
    const paged = crewPagedSchema.parse({ rows: [CREW], nextCursor: null });
    assert.equal(paged.rows.length, 1);
  });
});

describe('import job schemas', () => {
  it('accepts a job row with kind/status/counters', () => {
    assert.deepEqual(importJobListItemSchema.parse(JOB), JOB);
  });

  it('parses list and paged envelopes', () => {
    assert.deepEqual(importJobListSchema.parse([JOB]), [JOB]);
    const paged = importJobPagedSchema.parse({
      rows: [JOB],
      nextCursor: 'abc',
    });
    assert.equal(paged.nextCursor, 'abc');
  });
});
