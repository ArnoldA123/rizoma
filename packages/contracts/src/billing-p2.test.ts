// P2-0d contract coverage: cash sessions + budget lines listing schemas.
//
// Pins the shapes the P2 selectors consume: cash sessions carry the opener
// display name (`openedByName`, never a bare UUID) and budget lines carry
// the catalogue item names (`itemSku`/`itemName`), so screens render the
// description, never a UUID. Runner:
// `node --test src/billing-p2.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cashSessionListSchema,
  cashSessionPagedSchema,
  cashSessionRecordSchema,
} from './billing.ts';
import {
  budgetLineListSchema,
  budgetLinePagedSchema,
  budgetLineWithItemSchema,
} from './obras-operations.ts';

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orgNodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  openedBy: '22222222-2222-4222-8222-222222222222',
  openedByName: 'Cajero Demo',
  openedAt: '2026-09-26T08:00:00.000Z',
  closedAt: null,
  totals: {},
  status: 'open',
};

const LINE = {
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  siteId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  itemId: '44444444-4444-4444-8444-444444444444',
  description: 'Cemento Portland x50kg',
  qtyPlanned: 100,
  unitCost: 25.5,
  active: true,
  itemSku: 'CEM-50',
  itemName: 'Cemento Portland 50kg',
};

describe('cash session schemas', () => {
  it('accepts a session with the opener name resolved', () => {
    assert.deepEqual(cashSessionRecordSchema.parse(SESSION), SESSION);
  });

  it('accepts a null opener name on the open/close writes', () => {
    const parsed = cashSessionRecordSchema.parse({
      ...SESSION,
      openedByName: null,
    });
    assert.equal(parsed.openedByName, null);
  });

  it('parses list and paged envelopes', () => {
    assert.deepEqual(cashSessionListSchema.parse([SESSION]), [SESSION]);
    const paged = cashSessionPagedSchema.parse({
      rows: [SESSION],
      nextCursor: null,
    });
    assert.equal(paged.rows.length, 1);
  });
});

describe('budget line schemas', () => {
  it('accepts a line with item names resolved', () => {
    assert.deepEqual(budgetLineWithItemSchema.parse(LINE), LINE);
  });

  it('accepts a line without catalogue item', () => {
    const parsed = budgetLineWithItemSchema.parse({
      ...LINE,
      itemId: null,
      itemSku: null,
      itemName: null,
    });
    assert.equal(parsed.itemName, null);
  });

  it('parses list and paged envelopes', () => {
    assert.deepEqual(budgetLineListSchema.parse([LINE]), [LINE]);
    const paged = budgetLinePagedSchema.parse({
      rows: [LINE],
      nextCursor: 'abc',
    });
    assert.equal(paged.nextCursor, 'abc');
  });
});
