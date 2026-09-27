// P4-1a: `timezone` on the org listing (`listOrgNodes`, `listOrgNodesPage`).
//
// The SQL client is a small in-memory double answering the guard facts
// (membership, subtree, modules) and the listing query over synthetic rows.
// It pins that a stored IANA zone passes through, a legacy row without the
// column reads as `America/Lima`, and an unusable stored value falls back to
// Lima instead of leaking. All data is synthetic. Runner:
// `node --test test/org-timezone.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listOrgNodes,
  listOrgNodesPage,
  ORG_DEFAULT_TIMEZONE,
  type OrgActorContext,
  type OrgClient,
} from '../src/org/org.service.ts';

const TENANT = 'a7000000-0000-4000-8000-0000000000b1';
const ROOT = 'b7000000-0000-4000-8000-000000000011';
const SEDE_LIMA = 'b7000000-0000-4000-8000-000000000012';
const SEDE_MADRID = 'b7000000-0000-4000-8000-000000000013';
const SEDE_LEGACY = 'b7000000-0000-4000-8000-000000000014';
const SEDE_BROKEN = 'b7000000-0000-4000-8000-000000000015';
const USER = 'c7000000-0000-4000-8000-000000000011';
const MEMBERSHIP = 'd7000000-0000-4000-8000-000000000011';
const TRACE = 'trace-org-timezone';

type Row = Record<string, unknown>;

function nodeRow(
  id: string,
  name: string,
  timezone?: string | null,
  broken = false,
): Row {
  const row: Row = {
    id,
    tenant_id: TENANT,
    parent_id: ROOT,
    kind: 'sede',
    name,
    active: true,
  };
  // A legacy (pre-010) row carries no `timezone` key at all; a broken row
  // carries a value `Intl` cannot resolve.
  if (broken) row.timezone = 'Mars/Olympus';
  else if (timezone !== undefined && timezone !== null) row.timezone = timezone;
  return row;
}

const NODES: Row[] = [
  { id: ROOT, tenant_id: TENANT, parent_id: null, kind: 'empresa', name: 'Demo Company', active: true, timezone: 'America/Lima' },
  nodeRow(SEDE_LIMA, 'Sede Lima', 'America/Lima'),
  nodeRow(SEDE_MADRID, 'Sede Madrid', 'Europe/Madrid'),
  nodeRow(SEDE_LEGACY, 'Sede Legacy'),
  nodeRow(SEDE_BROKEN, 'Sede Broken', null, true),
];

const SUBTREE = NODES.map((row) => String(row.id));

interface FakeDb {
  readonly client: OrgClient;
}

function createDb(): FakeDb {
  const client: OrgClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return {
          rows: [
            {
              id: MEMBERSHIP,
              user_id: USER,
              tenant_id: TENANT,
              org_node_id: ROOT,
              role: 'recepcion',
              scopes: [],
              active: true,
              valid_from: '2020-01-01T00:00:00.000Z',
              valid_to: null,
              user_active: true,
            },
          ],
        };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: SUBTREE.map((id) => ({ id })) };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: ['crm-core', 'salud'] }] };
      }
      if (text.includes('FROM org_nodes WHERE')) {
        const scope = values[1] as string[];
        const rows = NODES.filter((row) => scope.includes(String(row.id))).sort(
          (left, right) =>
            String(left.name).localeCompare(String(right.name)) ||
            String(left.id).localeCompare(String(right.id)),
        );
        return { rows };
      }
      return { rows: [] };
    },
  };
  return { client };
}

function actor(db: FakeDb): OrgActorContext {
  return {
    client: db.client,
    tenantId: TENANT,
    userId: USER,
    roles: [],
    traceId: TRACE,
    ip: '127.0.0.1',
  };
}

describe('listOrgNodes timezone (P4-1a)', () => {
  it('exposes the stored IANA zone of every node', async () => {
    const rows = await listOrgNodes(actor(createDb()), {});
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get(SEDE_LIMA)?.timezone, 'America/Lima');
    assert.equal(byId.get(SEDE_MADRID)?.timezone, 'Europe/Madrid');
  });

  it('reads a legacy row without the column as America/Lima', async () => {
    assert.equal(ORG_DEFAULT_TIMEZONE, 'America/Lima');
    const rows = await listOrgNodes(actor(createDb()), {});
    const legacy = rows.find((row) => row.id === SEDE_LEGACY);
    assert.equal(legacy?.timezone, 'America/Lima');
  });

  it('falls back to Lima on an unusable stored value', async () => {
    const rows = await listOrgNodes(actor(createDb()), {});
    const broken = rows.find((row) => row.id === SEDE_BROKEN);
    assert.equal(broken?.timezone, 'America/Lima');
  });

  it('exposes the zone on the keyset page as well', async () => {
    const page = await listOrgNodesPage(actor(createDb()), { limit: '10' });
    const byId = new Map(page.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(SEDE_MADRID)?.timezone, 'Europe/Madrid');
    assert.equal(byId.get(SEDE_LEGACY)?.timezone, 'America/Lima');
    assert.equal(page.nextCursor, null);
  });
});
