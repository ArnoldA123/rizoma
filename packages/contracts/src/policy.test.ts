// Policy preview contract coverage (B5): the query builder, the schema
// round-trip and the two data mirrors (board gates, transition actions) the
// `/politicas` screen renders.
//
// The mirrors pin the values the API services already enforce, so a service
// change without the matching contract change fails here instead of drifting
// silently. Runner: `node --test src/policy.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  POLICY_ACTIONS,
  POLICY_BOARD_ACTIONS,
  POLICY_PREVIEW_ENTITIES,
  POLICY_ROLES,
  POLICY_TRANSITION_ACTIONS,
  policyPreviewQuerySchema,
  policyPreviewQueryString,
  policyPreviewSchema,
  type PolicyPreview,
} from './policy.ts';

describe('policy preview query', () => {
  it('builds the query string in controller order', () => {
    assert.equal(
      policyPreviewQueryString({ role: 'medico', entity: 'episode', estado: 'open' }),
      '?role=medico&entity=episode&estado=open',
    );
  });

  it('encodes values that need it', () => {
    assert.equal(
      policyPreviewQueryString({ role: 'jefe_obra', entity: 'site_log', estado: 'draft x' }),
      '?role=jefe_obra&entity=site_log&estado=draft%20x',
    );
  });

  it('rejects an entity outside the closed catalog', () => {
    assert.equal(
      policyPreviewQuerySchema.safeParse({ role: 'medico', entity: 'site', estado: 'active' })
        .success,
      false,
    );
  });

  it('rejects an empty role or estado', () => {
    assert.equal(
      policyPreviewQuerySchema.safeParse({ role: '', entity: 'episode', estado: 'open' }).success,
      false,
    );
    assert.equal(
      policyPreviewQuerySchema.safeParse({ role: 'medico', entity: 'episode', estado: '' }).success,
      false,
    );
  });
});

describe('policy preview response', () => {
  it('accepts a full preview payload', () => {
    const payload: PolicyPreview = {
      role: 'medico',
      entity: 'episode',
      estado: 'open',
      permittedActions: ['agenda.read', 'patient.read', 'patient.write', 'episode.write'],
      deniedActions: ['invoice.issue', 'attendance.approve'],
      transitions: [
        {
          from: 'open',
          to: 'closed',
          action: 'episode.write',
          roleListed: true,
          rolePermits: true,
          allowed: true,
        },
      ],
      boards: [{ board: 'medico', action: 'agenda.read', allowed: true }],
    };
    assert.equal(policyPreviewSchema.safeParse(payload).success, true);
  });

  it('rejects an undeclared action in the permitted list', () => {
    assert.equal(
      policyPreviewSchema.safeParse({
        role: 'caja',
        entity: 'episode',
        estado: 'open',
        permittedActions: ['cash.count'],
        deniedActions: [],
        transitions: [],
        boards: [],
      }).success,
      false,
    );
  });
});

describe('policy mirrors', () => {
  it('covers the 14 realm roles and the twelve demo actions', () => {
    assert.equal(POLICY_ROLES.length, 14);
    assert.equal(POLICY_ACTIONS.length, 12);
    assert.equal(POLICY_PREVIEW_ENTITIES.length, 3);
  });

  it('pins the board gates to the service mapping', () => {
    assert.deepEqual(POLICY_BOARD_ACTIONS, {
      recepcion: 'agenda.read',
      caja: 'invoice.issue',
      medico: 'agenda.read',
    });
  });

  it('pins each catalog entity to its enforcing action', () => {
    assert.deepEqual(POLICY_TRANSITION_ACTIONS, {
      episode: 'episode.write',
      attendance: 'attendance.approve',
      site_log: 'attendance.mark',
    });
  });
});
