// Keyset pagination contract coverage (R1).
//
// Protects the shared `pagination.ts` helpers every keyset listing mirrors:
// the opaque cursor roundtrips through its base64url JSON shape, malformed
// cursors throw (the API maps the throw to a 400), `parsePageLimit` clamps to
// the 200 cap instead of applying larger values, and `wantsKeysetPage` only
// fires when the caller actually sent `?cursor=` or `?limit=`. Runner:
// `node --test src/pagination.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeCursor,
  encodeCursor,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  parsePageLimit,
  wantsKeysetPage,
} from './pagination.ts';

function toCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('encodeCursor/decodeCursor roundtrip', () => {
  it('decodes what it encodes, key by key', () => {
    const payload = {
      createdAt: '2026-03-03T10:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    };
    assert.deepEqual(decodeCursor(encodeCursor(payload)), payload);
  });

  it('keeps the payload opaque (base64url, never the raw JSON)', () => {
    const payload = { code: 'OBR-001', id: '22222222-2222-4222-8222-222222222222' };
    const cursor = encodeCursor(payload);
    assert.equal(typeof cursor, 'string');
    assert.ok(!cursor.includes('{'), 'cursor must not embed raw JSON');
    assert.deepEqual(decodeCursor(cursor), payload);
  });

  it('rejects every malformed shape instead of returning a partial key', () => {
    const malformed = [
      'not-a-cursor!!!',
      '',
      toCursor([1, 2, 3]),
      toCursor({}),
      toCursor({ createdAt: '' }),
      toCursor({ createdAt: 42 }),
      toCursor(null),
      toCursor('just-a-string'),
    ];
    for (const cursor of malformed) {
      assert.throws(() => decodeCursor(cursor), /Invalid pagination cursor/, `must reject ${cursor}`);
    }
  });
});

describe('parsePageLimit', () => {
  it('defaults to 200 when the caller sends nothing usable', () => {
    assert.equal(parsePageLimit(undefined), PAGINATION_DEFAULT_LIMIT);
    assert.equal(parsePageLimit(null), PAGINATION_DEFAULT_LIMIT);
    assert.equal(parsePageLimit(''), PAGINATION_DEFAULT_LIMIT);
    assert.equal(PAGINATION_DEFAULT_LIMIT, 200);
  });

  it('accepts in-range values as numbers or numeric strings', () => {
    assert.equal(parsePageLimit(2), 2);
    assert.equal(parsePageLimit('2'), 2);
    assert.equal(parsePageLimit(200), 200);
    assert.equal(parsePageLimit(' 10 '), 10);
  });

  it('clamps 500 to the 200 hard cap instead of applying it', () => {
    assert.equal(parsePageLimit(500), PAGINATION_MAX_LIMIT);
    assert.equal(parsePageLimit('500'), PAGINATION_MAX_LIMIT);
    assert.equal(PAGINATION_MAX_LIMIT, 200);
  });

  it('throws for anything outside 1..200 that is not a clampable excess', () => {
    for (const raw of [0, -1, 1.5, Number.NaN, 'abc', '1.5', '0']) {
      assert.throws(() => parsePageLimit(raw), /Invalid pagination limit/, `must reject ${String(raw)}`);
    }
  });
});

describe('wantsKeysetPage', () => {
  it('stays on the legacy bare array when neither param is present', () => {
    assert.equal(wantsKeysetPage({}), false);
    assert.equal(wantsKeysetPage({ cursor: '', limit: '' }), false);
    assert.equal(wantsKeysetPage({ cursor: '   ', limit: undefined }), false);
  });

  it('fires on a non-empty cursor or any present limit', () => {
    assert.equal(wantsKeysetPage({ cursor: 'abc' }), true);
    assert.equal(wantsKeysetPage({ limit: '2' }), true);
    assert.equal(wantsKeysetPage({ limit: 2 }), true);
    assert.equal(wantsKeysetPage({ cursor: 'abc', limit: '2' }), true);
  });
});
