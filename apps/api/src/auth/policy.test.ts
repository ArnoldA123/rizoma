// Role × action matrix coverage (bases-consolidadas-v1.md §3.3, §3.4, §3.5).
//
// The suite pins the normative extracts that carry security meaning: auditor is
// read-only, caja issues invoices but never reads clinical history, a
// recepcion cannot open a record, a trabajador marks only their own attendance
// and never approves a third party, and the transversal roles stay denied by
// default. It also checks the matrix is complete for the 14 realm roles.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_CODES,
  ROLE_CODES,
  ROLE_PERMISSIONS,
  rolePermitsAction,
  type ActionCode,
  type RoleCode,
} from './policy.ts';

/** Actions that mutate state; the read-only role must be denied all of them. */
const WRITE_ACTIONS = [
  'patient.write',
  'episode.write',
  'appointment.write',
  'invoice.issue',
  'attendance.mark',
  'attendance.approve',
  'stock.consume',
  'site.write',
  'assignment.write',
] as const satisfies readonly ActionCode[];

describe('role matrix shape', () => {
  it('keys the matrix by exactly the 14 realm roles', () => {
    assert.equal(ROLE_CODES.length, 14);
    assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), [...ROLE_CODES].sort());
  });

  it('declares exactly the twelve demo actions, with no duplicates', () => {
    assert.equal(ACTION_CODES.length, 12);
    assert.equal(new Set(ACTION_CODES).size, ACTION_CODES.length);
  });

  it('only ever grants a declared action code', () => {
    for (const role of ROLE_CODES) {
      for (const action of ROLE_PERMISSIONS[role]) {
        assert.ok(
          (ACTION_CODES as readonly string[]).includes(action),
          `${role} grants undeclared action ${action}`,
        );
      }
    }
  });
});

describe('clinical matrix', () => {
  it('lets caja issue invoices', () => {
    assert.equal(rolePermitsAction('caja', 'invoice.issue'), true);
  });

  it('denies caja the clinical history and the agenda', () => {
    assert.equal(rolePermitsAction('caja', 'patient.read'), false);
    assert.equal(rolePermitsAction('caja', 'agenda.read'), false);
  });

  it('lets medico read patients and the agenda', () => {
    assert.equal(rolePermitsAction('medico', 'patient.read'), true);
    assert.equal(rolePermitsAction('medico', 'agenda.read'), true);
  });

  it('lets medico write the patient file and the episode, and no other clinical write', () => {
    assert.equal(rolePermitsAction('medico', 'patient.write'), true);
    assert.equal(rolePermitsAction('medico', 'episode.write'), true);
    assert.equal(rolePermitsAction('medico', 'appointment.write'), false);
  });

  it('lets recepcion register the patient file and schedule appointments', () => {
    assert.equal(rolePermitsAction('recepcion', 'patient.write'), true);
    assert.equal(rolePermitsAction('recepcion', 'appointment.write'), true);
  });

  it('denies recepcion opening a clinical history and editing an episode', () => {
    assert.equal(rolePermitsAction('recepcion', 'patient.read'), false);
    assert.equal(rolePermitsAction('recepcion', 'episode.write'), false);
  });

  it('leaves enfermeria read-only over the clinical history (§3.3 "lectura")', () => {
    assert.equal(rolePermitsAction('enfermeria', 'patient.read'), true);
    assert.equal(rolePermitsAction('enfermeria', 'patient.write'), false);
    assert.equal(rolePermitsAction('enfermeria', 'episode.write'), false);
    assert.equal(rolePermitsAction('enfermeria', 'appointment.write'), false);
  });

  it('denies medico amounts and invoice issuing', () => {
    assert.equal(rolePermitsAction('medico', 'invoice.issue'), false);
  });

  it('lets enfermeria read the clinical history without writing', () => {
    assert.equal(rolePermitsAction('enfermeria', 'patient.read'), true);
    assert.equal(rolePermitsAction('enfermeria', 'invoice.issue'), false);
  });

  it('lets recepcion read the agenda but not open a clinical history', () => {
    assert.equal(rolePermitsAction('recepcion', 'agenda.read'), true);
    assert.equal(rolePermitsAction('recepcion', 'patient.read'), false);
  });

  it('denies direccion the clinical history and invoice issuing', () => {
    assert.equal(rolePermitsAction('direccion', 'patient.read'), false);
    assert.equal(rolePermitsAction('direccion', 'invoice.issue'), false);
  });

  it('denies caja every clinical write as well as clinical reads', () => {
    assert.equal(rolePermitsAction('caja', 'patient.write'), false);
    assert.equal(rolePermitsAction('caja', 'episode.write'), false);
    assert.equal(rolePermitsAction('caja', 'appointment.write'), false);
  });

  it('keeps auditor read-only: no clinical history and no write action', () => {
    assert.equal(rolePermitsAction('auditor', 'agenda.read'), true);
    assert.equal(rolePermitsAction('auditor', 'patient.read'), false);
    for (const action of WRITE_ACTIONS) {
      assert.equal(rolePermitsAction('auditor', action), false, `auditor must not ${action}`);
    }
  });
});

describe('clinical write coverage', () => {
  it('admits exactly one writer of the patient file and the episode', () => {
    const patientWriters = ROLE_CODES.filter((role) => rolePermitsAction(role, 'patient.write'));
    assert.deepEqual(patientWriters, ['medico', 'recepcion']);
    const episodeWriters = ROLE_CODES.filter((role) => rolePermitsAction(role, 'episode.write'));
    assert.deepEqual(episodeWriters, ['medico']);
  });

  it('admits exactly one scheduler of appointments', () => {
    const schedulers = ROLE_CODES.filter((role) => rolePermitsAction(role, 'appointment.write'));
    assert.deepEqual(schedulers, ['recepcion']);
  });
});

describe('construction matrix', () => {
  it('lets a trabajador mark their own attendance', () => {
    assert.equal(rolePermitsAction('trabajador', 'attendance.mark'), true);
  });

  it('denies a trabajador approving a third party and consuming stock', () => {
    assert.equal(rolePermitsAction('trabajador', 'attendance.approve'), false);
    assert.equal(rolePermitsAction('trabajador', 'stock.consume'), false);
  });

  it('denies almacen approving attendance but allows stock consumption', () => {
    assert.equal(rolePermitsAction('almacen', 'attendance.approve'), false);
    assert.equal(rolePermitsAction('almacen', 'stock.consume'), true);
  });

  it('lets capataz approve their crew and consume stock', () => {
    assert.equal(rolePermitsAction('capataz', 'attendance.approve'), true);
    assert.equal(rolePermitsAction('capataz', 'stock.consume'), true);
  });

  it('lets gerente and jefe_obra approve attendance and consume stock', () => {
    for (const role of ['gerente', 'jefe_obra'] as const) {
      assert.equal(rolePermitsAction(role, 'attendance.approve'), true);
      assert.equal(rolePermitsAction(role, 'stock.consume'), true);
    }
  });

  it('lets every construction role read the site it can reach', () => {
    for (const role of ['gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador', 'auditor'] as const) {
      assert.equal(rolePermitsAction(role, 'site.read'), true, `${role} must read a site`);
    }
  });

  it('admits exactly one creator of sites: gerente', () => {
    const creators = ROLE_CODES.filter((role) => rolePermitsAction(role, 'site.write'));
    assert.deepEqual(creators, ['gerente']);
  });

  it('lets gerente and jefe_obra assign workers, and nobody else', () => {
    const assigners = ROLE_CODES.filter((role) => rolePermitsAction(role, 'assignment.write'));
    assert.deepEqual(assigners, ['gerente', 'jefe_obra']);
  });

  it('leaves auditor read-only over the site and denies every construction write', () => {
    assert.equal(rolePermitsAction('auditor', 'site.read'), true);
    for (const role of ['almacen', 'capataz', 'trabajador'] as const) {
      assert.equal(rolePermitsAction(role, 'site.write'), false, `${role} must not create a site`);
      assert.equal(rolePermitsAction(role, 'assignment.write'), false, `${role} must not assign`);
    }
  });

  it('denies construction roles the invoice and the clinical history', () => {
    for (const role of ['gerente', 'jefe_obra', 'almacen', 'capataz', 'trabajador'] as const) {
      assert.equal(rolePermitsAction(role, 'invoice.issue'), false, `${role} must not invoice`);
      assert.equal(rolePermitsAction(role, 'patient.read'), false, `${role} must not read history`);
    }
  });
});

describe('deny by default', () => {
  it('grants nothing to the transversal vendedor and soporte roles', () => {
    for (const role of ['vendedor', 'soporte'] as const) {
      for (const action of ACTION_CODES) {
        assert.equal(rolePermitsAction(role, action), false, `${role} must not ${action}`);
      }
    }
  });

  it('denies an unknown role', () => {
    assert.equal(rolePermitsAction('fantasma', 'agenda.read'), false);
  });

  it('denies an unknown action for a role that exists', () => {
    assert.equal(rolePermitsAction('caja', 'invoice.refund'), false);
  });

  it('admits exactly one issuer of invoices: caja', () => {
    const issuers = ROLE_CODES.filter((role) => rolePermitsAction(role, 'invoice.issue'));
    assert.deepEqual(issuers, ['caja']);
  });
});

describe('purity', () => {
  it('returns the same answer on repeated calls and never mutates the matrix', () => {
    const before = ROLE_CODES.map((role) => ROLE_PERMISSIONS[role].size);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(rolePermitsAction('medico', 'patient.read'), true);
      assert.equal(rolePermitsAction('trabajador', 'attendance.approve'), false);
    }
    const after = ROLE_CODES.map((role) => ROLE_PERMISSIONS[role].size);
    assert.deepEqual(after, before);
  });

  it('exposes each grant as a set, so membership is queryable per role', () => {
    assert.ok(ROLE_PERMISSIONS.caja instanceof Set);
    assert.equal(ROLE_PERMISSIONS.caja.has('invoice.issue'), true);
    assert.equal(ROLE_PERMISSIONS.caja.has('patient.read'), false);
  });
});

describe('typed entry points', () => {
  it('accepts the literal role and action codes', () => {
    const typedRole: RoleCode = 'auditor';
    const typedAction: ActionCode = 'agenda.read';
    assert.equal(rolePermitsAction(typedRole, typedAction), true);
  });
});
