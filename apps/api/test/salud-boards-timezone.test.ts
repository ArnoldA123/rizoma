// P4-1a: the salud board resolves "today" in the sede's zone, never UTC.
//
// The SQL client is an in-memory double answering the guard facts
// (membership, subtree, modules), the sede zone lookup (`SELECT timezone
// FROM org_nodes`) and the recepcion aggregate. The clock is frozen at a
// fixed instant on the day edge so the sede day and the UTC day provably
// differ. All data is synthetic. Runner:
// `node --test test/salud-boards-timezone.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getBoard,
  isValidIanaTimezone,
  normalizeOrgTimezone,
  ORG_DEFAULT_TIMEZONE,
  todayInTimezone,
} from '../src/salud/dashboards.service.ts';
import type { ActorContext, SaludClient } from '../src/salud/salud.service.ts';

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000b1';
const SEDE = 'b1000000-0000-4000-8000-0000000000b1';
const USER = 'c1000000-0000-4000-8000-0000000000b1';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000b1';
const TRACE = 'trace-salud-tz-1';

/** Frozen edge: 02:00 UTC is still "yesterday" in Lima (UTC-5). */
const EDGE_ISO = '2026-01-15T02:00:00.000Z';
const EDGE_UTC_DAY = '2026-01-15';
const EDGE_LIMA_DAY = '2026-01-14';

const RealDate = globalThis.Date;

/** Runs `fn` with `new Date()` / `Date.now()` pinned to `iso`. */
async function withFrozenNow<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const fixed = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args: never[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as unknown as []));
    }
    static now(): number {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: { text: string; values: readonly unknown[] }[];
}

/**
 * Double with a configurable sede zone: `'missing'` answers no zone row
 * (unknown sede), every other value is stored verbatim (including garbage).
 */
function createDb(zone: string | 'missing'): FakeDb {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: MEMBERSHIP_ID,
              user_id: USER,
              tenant_id: TENANT_ID,
              org_node_id: SEDE,
              role: 'recepcion',
              scopes: [],
              active: true,
              valid_from: '2025-01-01T00:00:00.000Z',
              valid_to: null,
              user_active: true,
            },
          ],
        };
      }
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE }] };
      if (text.includes('SELECT modules FROM tenants')) return { rows: [{ modules: ['salud'] }] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('SELECT timezone FROM org_nodes')) {
        if (zone === 'missing') return { rows: [] };
        return { rows: [{ timezone: zone }] };
      }
      if (text.includes('today_appointments')) {
        return {
          rows: [{ today_appointments: '4', waiting_avg_min: '5', no_shows: '0', queue: '1' }],
        };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

function actor(client: SaludClient): ActorContext {
  return { client, tenantId: TENANT_ID, userId: USER, roles: [], traceId: TRACE, ip: null };
}

describe('todayInTimezone (sede day, never UTC)', () => {
  it('resolves the same instant to different days across zones', () => {
    const at = new RealDate('2026-06-01T11:30:00.000Z');
    // 11:30 UTC is 06:30 in Lima but 01:30 of the next day in Kiritimati (+14).
    assert.equal(todayInTimezone('America/Lima', at), '2026-06-01');
    assert.equal(todayInTimezone('Pacific/Kiritimati', at), '2026-06-02');
    assert.equal(todayInTimezone('UTC', at), '2026-06-01');
  });

  it('validates and normalizes zones with a Lima fallback', () => {
    assert.equal(isValidIanaTimezone('America/Lima'), true);
    assert.equal(isValidIanaTimezone('Mars/Olympus'), false);
    assert.equal(isValidIanaTimezone(''), false);
    assert.equal(isValidIanaTimezone(null), false);
    assert.equal(normalizeOrgTimezone('Europe/Madrid'), 'Europe/Madrid');
    assert.equal(normalizeOrgTimezone('Mars/Olympus'), 'America/Lima');
    assert.equal(ORG_DEFAULT_TIMEZONE, 'America/Lima');
  });
});

describe('getBoard default day (sede zone)', () => {
  it('labels the board with the sede day, not the UTC day, on the edge', async () => {
    const db = createDb('America/Lima');
    const board = await withFrozenNow(EDGE_ISO, () =>
      getBoard(actor(db.client), 'recepcion'),
    );
    assert.equal(board.role, 'recepcion');
    assert.equal(board.date, EDGE_LIMA_DAY);
    assert.notEqual(board.date, EDGE_UTC_DAY);
  });

  it('falls back to Lima when the sede has no zone row', async () => {
    const db = createDb('missing');
    const board = await withFrozenNow(EDGE_ISO, () =>
      getBoard(actor(db.client), 'recepcion'),
    );
    assert.equal(board.date, EDGE_LIMA_DAY);
  });

  it('falls back to Lima on an unusable stored zone', async () => {
    const db = createDb('Mars/Olympus');
    const board = await withFrozenNow(EDGE_ISO, () =>
      getBoard(actor(db.client), 'recepcion'),
    );
    assert.equal(board.date, EDGE_LIMA_DAY);
  });

  it('keeps honoring an explicit ?date= without touching the zone lookup', async () => {
    const db = createDb('Pacific/Kiritimati');
    const board = await withFrozenNow(EDGE_ISO, () =>
      getBoard(actor(db.client), 'recepcion', undefined, '2026-09-25'),
    );
    assert.equal(board.date, '2026-09-25');
    assert.ok(
      db.queries.every((query) => !query.text.includes('SELECT timezone FROM org_nodes')),
      'an explicit date must not trigger a zone lookup',
    );
  });
});
