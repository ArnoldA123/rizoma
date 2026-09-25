// Saved-view contract tests (B1) — synthetic payloads only, no live API.
//
// The schemas accept the exact shapes the `saved_views` row mapper emits and
// refuse what the unindexed `filters` JSONB cannot apply: operators, nesting,
// unknown keys and oversized bags. Runner: `node --test src/views.test.ts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_SAVED_VIEW_FILTER_KEYS,
  MAX_SAVED_VIEW_FILTERS,
  savedViewCreateInputSchema,
  savedViewFiltersSchema,
  savedViewIdQueryString,
  savedViewRecordSchema,
  savedViewUpdateInputSchema,
  savedViewsQueryString,
  SAVED_VIEW_FILTER_KEYS,
} from './views.ts';

const VIEW_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const TENANT_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const USER_ID = 'b1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('savedViewRecordSchema', () => {
  it('accepts the row shape the API mapper emits', () => {
    const parsed = savedViewRecordSchema.safeParse({
      id: VIEW_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      entity: 'patients',
      filters: { active: true, documentType: 'DNI' },
      shared: false,
      active: true,
    });
    assert.equal(parsed.success, true);
  });

  it('accepts a null owner (legacy/global rows)', () => {
    const parsed = savedViewRecordSchema.safeParse({
      id: VIEW_ID,
      tenantId: TENANT_ID,
      userId: null,
      entity: 'invoices',
      filters: {},
      shared: true,
      active: true,
    });
    assert.equal(parsed.success, true);
  });

  it('rejects an entity outside the closed list', () => {
    const parsed = savedViewRecordSchema.safeParse({
      id: VIEW_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      entity: 'episodes',
      filters: {},
      shared: false,
      active: true,
    });
    assert.equal(parsed.success, false);
  });
});

describe('savedViewCreateInputSchema', () => {
  it('defaults filters and shared', () => {
    const parsed = savedViewCreateInputSchema.safeParse({ entity: 'attendance' });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.deepEqual(parsed.data.filters, {});
      assert.equal(parsed.data.shared, false);
    }
  });

  it('accepts scalar values of every kind', () => {
    const parsed = savedViewCreateInputSchema.safeParse({
      entity: 'invoices',
      filters: { status: 'paid', serie: 'F001', fiscalStatus: 'sent' },
      shared: true,
    });
    assert.equal(parsed.success, true);
  });

  it('rejects a filter key the entity cannot apply', () => {
    const parsed = savedViewCreateInputSchema.safeParse({
      entity: 'patients',
      filters: { status: 'paid' },
    });
    assert.equal(parsed.success, false);
  });

  it('rejects operators, nesting and non-camelCase keys', () => {
    for (const filters of [
      { $gt: 'x' },
      { 'status.$in': ['a'] },
      { status: { eq: 'paid' } },
      { status: ['paid'] },
    ]) {
      const parsed = savedViewCreateInputSchema.safeParse({ entity: 'invoices', filters });
      assert.equal(parsed.success, false, JSON.stringify(filters));
    }
  });

  it('rejects bags over the entry cap', () => {
    const filters: Record<string, string> = {};
    for (let i = 0; i < MAX_SAVED_VIEW_FILTERS + 1; i += 1) filters[`k${i}`] = 'v';
    const parsed = savedViewFiltersSchema.safeParse(filters);
    assert.equal(parsed.success, false);
  });
});

describe('savedViewUpdateInputSchema', () => {
  it('requires at least one field', () => {
    assert.equal(savedViewUpdateInputSchema.safeParse({}).success, false);
  });

  it('accepts a shared-only toggle', () => {
    assert.equal(savedViewUpdateInputSchema.safeParse({ shared: true }).success, true);
  });

  it('checks filters against the union when no entity rides along', () => {
    assert.equal(
      savedViewUpdateInputSchema.safeParse({ filters: { status: 'paid' } }).success,
      true,
    );
    assert.equal(
      savedViewUpdateInputSchema.safeParse({ filters: { nope: 'x' } }).success,
      false,
    );
  });

  it('checks filters against the entity when both ride along', () => {
    assert.equal(
      savedViewUpdateInputSchema.safeParse({ entity: 'patients', filters: { status: 'x' } })
        .success,
      false,
    );
  });
});

describe('saved view query helpers', () => {
  it('omits empty entity filters and encodes the rest', () => {
    assert.equal(savedViewsQueryString(), '');
    assert.equal(savedViewsQueryString({ entity: '' }), '');
    assert.equal(savedViewsQueryString({ entity: 'patients' }), '?entity=patients');
  });

  it('builds the saved_view_id suffix for the existing listings', () => {
    assert.equal(savedViewIdQueryString(null), '');
    assert.equal(savedViewIdQueryString(''), '');
    assert.equal(savedViewIdQueryString(VIEW_ID), `?saved_view_id=${VIEW_ID}`);
  });

  it('covers every entity with at least one key', () => {
    for (const entity of ['patients', 'appointments', 'invoices', 'attendance'] as const) {
      assert.ok(SAVED_VIEW_FILTER_KEYS[entity].length > 0, entity);
    }
    assert.ok(ALL_SAVED_VIEW_FILTER_KEYS.includes('status'));
  });
});
