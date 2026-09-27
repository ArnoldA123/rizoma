// Policy preview coverage (B5): the matrix × catalog conjunction the endpoint
// exposes for audit — a listed triple with a granted role allows, a role
// outside the grant denies, an unlisted state yields no moves, an unknown role
// denies everything without throwing, and a query failure reads as no moves
// (fail-closed, never throws).
//
// The client is a tiny in-memory double over synthetic catalog rows; all data
// is synthetic. Runner: `node --test src/policy/policy.test.ts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  getPolicyPreview,
  listTransitions,
  parsePreviewQuery,
  previewTransition,
  splitActions,
  type PreviewClient,
} from './policy.service.ts';

const TENANT = 'c9000000-0000-4000-8000-0000000000c9';

interface CatalogRow {
  readonly tenantId: string;
  readonly entity: string;
  readonly from: string;
  readonly to: string;
  readonly allowedRoles: string[];
}

const SEED: readonly CatalogRow[] = [
  { tenantId: TENANT, entity: 'episode', from: 'open', to: 'cancelled', allowedRoles: ['medico'] },
  { tenantId: TENANT, entity: 'episode', from: 'open', to: 'closed', allowedRoles: ['medico'] },
  {
    tenantId: TENANT,
    entity: 'attendance',
    from: 'registered',
    to: 'adjusted',
    allowedRoles: ['gerente', 'jefe_obra', 'capataz'],
  },
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
    tenantId: 'd9000000-0000-4000-8000-0000000000d9',
    entity: 'episode',
    from: 'open',
    to: 'closed',
    allowedRoles: ['medico'],
  },
];

function catalogClient(rows: readonly CatalogRow[], fail = false): PreviewClient {
  return {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      if (fail) throw new Error('catalog unreachable');
      assert.match(text, /FROM state_transitions/);
      const [tenantId, entity, from] = values as [string, string, string];
      const matched = rows
        .filter((row) => row.tenantId === tenantId && row.entity === entity && row.from === from)
        .map((row) => ({
          from_status: row.from,
          to_status: row.to,
          allowed_roles: row.allowedRoles,
        }));
      return { rows: matched };
    },
  };
}

describe('parsePreviewQuery', () => {
  it('accepts a complete triple, including an unknown role', () => {
    assert.deepEqual(
      parsePreviewQuery({ role: 'fantasma', entity: 'episode', estado: 'open' }, 'trace-1'),
      { role: 'fantasma', entity: 'episode', estado: 'open' },
    );
  });

  it('rejects an entity outside the closed catalog with a 400', () => {
    assert.throws(
      () => parsePreviewQuery({ role: 'medico', entity: 'site', estado: 'active' }, 'trace-1'),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 400 &&
        (error.getResponse() as { code?: string }).code === 'policy.unknown_entity',
    );
  });

  it('rejects an empty role or estado with a 400', () => {
    assert.throws(
      () => parsePreviewQuery({ role: '', entity: 'episode', estado: 'open' }, 'trace-1'),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
    );
    assert.throws(
      () => parsePreviewQuery({ role: 'medico', entity: 'episode', estado: '' }, 'trace-1'),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
    );
  });
});

describe('splitActions', () => {
  it('grants medico the clinical writes but never the cashier action', () => {
    const { permitted, denied } = splitActions('medico');
    assert.ok(permitted.includes('episode.write'));
    assert.ok(denied.includes('invoice.issue'));
  });

  it('denies every action to an unknown role', () => {
    const { permitted, denied } = splitActions('fantasma');
    assert.equal(permitted.length, 0);
    assert.equal(denied.length, 13);
  });
});

describe('previewTransition', () => {
  it('allows a listed role that also holds the enforcing action', () => {
    const verdict = previewTransition('medico', 'episode', {
      from: 'open',
      to: 'closed',
      allowedRoles: ['medico'],
    });
    assert.equal(verdict.action, 'episode.write');
    assert.equal(verdict.roleListed, true);
    assert.equal(verdict.rolePermits, true);
    assert.equal(verdict.allowed, true);
  });

  it('allows a listed on-site role on the site_log publish move', () => {
    // Every role the seed lists on site_log/draft→published also holds
    // `attendance.mark`, so the conjunction agrees with the catalog term;
    // the second half pins the denial when the role is listed nowhere.
    const listed = previewTransition('trabajador', 'site_log', {
      from: 'draft',
      to: 'published',
      allowedRoles: ['gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador'],
    });
    assert.equal(listed.action, 'attendance.mark');
    assert.equal(listed.roleListed, true);
    assert.equal(listed.rolePermits, true);
    assert.equal(listed.allowed, true);
    const unlisted = previewTransition('auditor', 'site_log', {
      from: 'draft',
      to: 'published',
      allowedRoles: ['gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador'],
    });
    assert.equal(unlisted.roleListed, false);
    assert.equal(unlisted.allowed, false);
  });
});

describe('getPolicyPreview', () => {
  it('previews medico on an open episode: writes plus both closing moves', async () => {
    const preview = await getPolicyPreview(
      catalogClient(SEED),
      TENANT,
      'medico',
      'episode',
      'open',
    );
    assert.ok(preview.permittedActions.includes('episode.write'));
    assert.ok(preview.deniedActions.includes('invoice.issue'));
    assert.deepEqual(
      preview.transitions.map((move) => move.to),
      ['cancelled', 'closed'],
    );
    assert.ok(preview.transitions.every((move) => move.allowed));
    const medicoBoard = preview.boards.find((board) => board.board === 'medico');
    assert.equal(medicoBoard?.allowed, true);
    assert.equal(
      preview.boards.find((board) => board.board === 'caja')?.allowed,
      false,
    );
  });

  it('denies recepcion the episode moves while keeping its agenda reads', async () => {
    const preview = await getPolicyPreview(
      catalogClient(SEED),
      TENANT,
      'recepcion',
      'episode',
      'open',
    );
    assert.ok(preview.permittedActions.includes('agenda.read'));
    assert.ok(preview.deniedActions.includes('episode.write'));
    assert.equal(preview.transitions.length, 2);
    assert.ok(preview.transitions.every((move) => !move.allowed));
  });

  it('allows capataz the attendance approvals and denies trabajador', async () => {
    const capataz = await getPolicyPreview(
      catalogClient(SEED),
      TENANT,
      'capataz',
      'attendance',
      'registered',
    );
    assert.ok(capataz.permittedActions.includes('attendance.approve'));
    assert.ok(capataz.transitions.every((move) => move.allowed));
    const trabajador = await getPolicyPreview(
      catalogClient(SEED),
      TENANT,
      'trabajador',
      'attendance',
      'registered',
    );
    assert.ok(trabajador.deniedActions.includes('attendance.approve'));
    assert.ok(trabajador.transitions.every((move) => !move.allowed));
  });

  it('yields no moves for a state the catalog does not list', async () => {
    const preview = await getPolicyPreview(
      catalogClient(SEED),
      TENANT,
      'medico',
      'episode',
      'closed',
    );
    assert.equal(preview.transitions.length, 0);
    assert.ok(preview.permittedActions.includes('episode.write'));
  });

  it('denies an unknown role on every term without throwing', async () => {
    const preview = await getPolicyPreview(
      catalogClient(SEED),
      TENANT,
      'fantasma',
      'episode',
      'open',
    );
    assert.equal(preview.permittedActions.length, 0);
    assert.ok(preview.transitions.every((move) => !move.allowed));
    assert.ok(preview.boards.every((board) => !board.allowed));
  });

  it('ignores rows of another tenant', async () => {
    const preview = await getPolicyPreview(
      catalogClient(SEED),
      'e9000000-0000-4000-8000-0000000000e9',
      'medico',
      'episode',
      'open',
    );
    assert.equal(preview.transitions.length, 0);
  });

  it('reads no moves instead of throwing when the catalog query fails', async () => {
    const rows = await listTransitions(catalogClient(SEED, true), TENANT, 'episode', 'open');
    assert.deepEqual(rows, []);
    const preview = await getPolicyPreview(
      catalogClient(SEED, true),
      TENANT,
      'medico',
      'episode',
      'open',
    );
    assert.equal(preview.transitions.length, 0);
    assert.ok(preview.permittedActions.includes('episode.write'));
  });
});
