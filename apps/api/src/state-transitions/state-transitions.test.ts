// Coverage for the closed transition catalog (`state-transitions.service.ts`,
// migration 009, B3): a listed triple with a granted role allows, an unlisted
// triple denies, a role outside the grant denies, an unknown entity denies,
// and a query failure denies (fail-closed term, never throws).
//
// The client is a tiny in-memory double over synthetic catalog rows; all data
// is synthetic. Runner: `node --test src/state-transitions/state-transitions.test.ts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertTransition,
  type TransitionClient,
} from './state-transitions.service.ts';

const TENANT = 'a9000000-0000-4000-8000-0000000000a9';

interface CatalogRow {
  readonly tenantId: string;
  readonly entity: string;
  readonly from: string;
  readonly to: string;
  readonly allowedRoles: string[];
}

const SEED: readonly CatalogRow[] = [
  { tenantId: TENANT, entity: 'episode', from: 'open', to: 'closed', allowedRoles: ['medico'] },
  { tenantId: TENANT, entity: 'episode', from: 'open', to: 'cancelled', allowedRoles: ['medico'] },
  {
    tenantId: TENANT,
    entity: 'attendance',
    from: 'registered',
    to: 'approved',
    allowedRoles: ['gerente', 'jefe_obra', 'capataz'],
  },
  {
    tenantId: TENANT,
    entity: 'attendance',
    from: 'registered',
    to: 'rejected',
    allowedRoles: ['gerente', 'jefe_obra', 'capataz'],
  },
  {
    tenantId: TENANT,
    entity: 'attendance',
    from: 'registered',
    to: 'adjusted',
    allowedRoles: ['gerente', 'jefe_obra', 'capataz'],
  },
  {
    tenantId: TENANT,
    entity: 'site_log',
    from: 'draft',
    to: 'published',
    allowedRoles: ['gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador'],
  },
];

function catalogClient(rows: readonly CatalogRow[], fail = false): TransitionClient {
  return {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      if (fail) throw new Error('relation "state_transitions" does not exist');
      const scoped = text.includes('tenant_id = $1');
      const [tenantId, entity, from, to] = scoped
        ? [String(values[0]), String(values[1]), String(values[2]), String(values[3])]
        : [TENANT, String(values[0]), String(values[1]), String(values[2])];
      const match = rows.find(
        (row) =>
          row.tenantId === tenantId &&
          row.entity === entity &&
          row.from === from &&
          row.to === to,
      );
      return { rows: match === undefined ? [] : [{ allowed_roles: [...match.allowedRoles] }] };
    },
  };
}

describe('assertTransition', () => {
  it('allows a seeded transition when the role is granted', async () => {
    const client = catalogClient(SEED);
    assert.equal(
      await assertTransition(client, {
        entity: 'episode',
        from: 'open',
        to: 'closed',
        role: 'medico',
        tenantId: TENANT,
      }),
      true,
    );
    assert.equal(
      await assertTransition(client, {
        entity: 'attendance',
        from: 'registered',
        to: 'approved',
        role: 'capataz',
        tenantId: TENANT,
      }),
      true,
    );
    assert.equal(
      await assertTransition(client, {
        entity: 'site_log',
        from: 'draft',
        to: 'published',
        role: 'trabajador',
        tenantId: TENANT,
      }),
      true,
    );
  });

  it('denies a seeded triple when the role is outside the grant', async () => {
    const client = catalogClient(SEED);
    assert.equal(
      await assertTransition(client, {
        entity: 'episode',
        from: 'open',
        to: 'closed',
        role: 'recepcion',
        tenantId: TENANT,
      }),
      false,
    );
    assert.equal(
      await assertTransition(client, {
        entity: 'attendance',
        from: 'registered',
        to: 'approved',
        role: 'trabajador',
        tenantId: TENANT,
      }),
      false,
    );
  });

  it('denies an unlisted transition (closed machine)', async () => {
    const client = catalogClient(SEED);
    assert.equal(
      await assertTransition(client, {
        entity: 'episode',
        from: 'closed',
        to: 'closed',
        role: 'medico',
        tenantId: TENANT,
      }),
      false,
    );
    assert.equal(
      await assertTransition(client, {
        entity: 'attendance',
        from: 'approved',
        to: 'approved',
        role: 'gerente',
        tenantId: TENANT,
      }),
      false,
    );
    assert.equal(
      await assertTransition(client, {
        entity: 'site_log',
        from: 'published',
        to: 'published',
        role: 'gerente',
        tenantId: TENANT,
      }),
      false,
    );
  });

  it('denies an entity outside the catalog', async () => {
    const client = catalogClient(SEED);
    assert.equal(
      await assertTransition(client, {
        entity: 'appointment',
        from: 'scheduled',
        to: 'done',
        role: 'medico',
        tenantId: TENANT,
      }),
      false,
    );
    assert.equal(
      await assertTransition(client, {
        entity: 'site',
        from: 'active',
        to: 'closed',
        role: 'gerente',
        tenantId: TENANT,
      }),
      false,
    );
  });

  it('denies instead of throwing when the catalog query fails', async () => {
    const client = catalogClient(SEED, true);
    assert.equal(
      await assertTransition(client, {
        entity: 'episode',
        from: 'open',
        to: 'closed',
        role: 'medico',
        tenantId: TENANT,
      }),
      false,
    );
  });

  it('denies a row of another tenant (explicit tenant scope)', async () => {
    const client = catalogClient(SEED);
    assert.equal(
      await assertTransition(client, {
        entity: 'episode',
        from: 'open',
        to: 'closed',
        role: 'medico',
        tenantId: 'b9000000-0000-4000-8000-0000000000b9',
      }),
      false,
    );
  });
});
