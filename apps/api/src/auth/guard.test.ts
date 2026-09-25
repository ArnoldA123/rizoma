// Denial matrix (bases-consolidadas-v1.md §3.5) + one happy path.
// Runs with node:test, no dependencies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideAccess, type AccessRequest } from './guard.ts';

const base: AccessRequest = {
  userActive: true,
  membershipActive: true,
  now: '2026-09-24T12:00:00-05:00',
  validFrom: '2026-01-01T00:00:00-05:00',
  validTo: null,
  entityOrgNodeId: 'org-sede-a',
  scopeSubtree: ['org-empresa', 'org-sede-a'],
  rolePermits: true,
  stateAllows: true,
  moduleActive: true,
};

describe('decideAccess', () => {
  it('allows a fully valid request', () => {
    assert.equal(decideAccess(base).allow, true);
  });
  it('recepcion opening clinical history -> role.denied', () => {
    assert.deepEqual(decideAccess({ ...base, rolePermits: false }).reason, 'role.denied');
  });
  it('medico with inactive membership -> membership.inactive', () => {
    assert.deepEqual(
      decideAccess({ ...base, membershipActive: false }).reason, 'membership.inactive',
    );
  });
  it('offboarded user with live token -> user.inactive', () => {
    assert.deepEqual(decideAccess({ ...base, userActive: false }).reason, 'user.inactive');
  });
  it('expired membership -> membership.expired', () => {
    assert.deepEqual(
      decideAccess({ ...base, validTo: '2026-09-01T00:00:00-05:00' }).reason,
      'membership.expired',
    );
  });
  it('caja of sede A on sede B -> scope.outside_subtree', () => {
    assert.deepEqual(
      decideAccess({ ...base, entityOrgNodeId: 'org-sede-b' }).reason,
      'scope.outside_subtree',
    );
  });
  it('jefe_obra A opening obra B -> scope.outside_subtree', () => {
    assert.deepEqual(
      decideAccess({ ...base, entityOrgNodeId: 'org-obra-b', scopeSubtree: ['org-obra-a'] }).reason,
      'scope.outside_subtree',
    );
  });
  it('editing a voided invoice -> state.denied', () => {
    assert.deepEqual(decideAccess({ ...base, stateAllows: false }).reason, 'state.denied');
  });
  it('tenant without salud module -> module.inactive', () => {
    assert.deepEqual(decideAccess({ ...base, moduleActive: false }).reason, 'module.inactive');
  });
  it('auditor attempting any write -> role.denied', () => {
    assert.deepEqual(decideAccess({ ...base, rolePermits: false }).reason, 'role.denied');
  });
  it('worker from obra A marking obra B -> scope.outside_subtree', () => {
    assert.deepEqual(
      decideAccess({
        ...base, entityOrgNodeId: 'org-obra-b', scopeSubtree: ['org-empresa', 'org-obra-a'],
      }).reason,
      'scope.outside_subtree',
    );
  });
});
