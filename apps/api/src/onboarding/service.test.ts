// Onboarding state machine (peru-anexo-v1.md §11 — 7-step first-run wizard).
// Runs with node:test, no dependencies. All data is synthetic
// (demo RUC generated on the fly, @example.invalid mailboxes).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCheckDigit } from './ruc.ts';
import {
  STEPS,
  advance,
  canonicalJson,
  requireOnboarded,
  resumeFrom,
  type OnboardingCase,
  type StepNumber,
} from './service.ts';

/** Synthetic demo RUC: base + its own SUNAT check digit. */
const DEMO_RUC = `2012345678${computeCheckDigit('2012345678')}`;

const ORGANIZER = {
  legalName: 'Clinica Demo Norte S.A.C.',
  ruc: DEMO_RUC,
  fiscalAddress: 'Av. Demo 123, Lima',
};

const SITES = {
  sites: [
    {
      name: 'Sede Demo Norte',
      address: 'Av. Demo 123, Lima',
      arcoEmail: 'arco.norte@example.invalid',
    },
    {
      name: 'Sede Demo Sur',
      address: 'Calle Demo 456, Arequipa',
      arcoEmail: 'arco.sur@example.invalid',
    },
  ],
};

const IDENTITY = {
  visibleName: 'Demo Salud',
  responsible: 'Dra. Demo Responsable',
};

const BILLING_MANUAL = { mode: 'manual' };

const ADMIN = {
  username: 'admin.demo',
  email: 'admin.demo@example.invalid',
  mfaEnrolled: true,
};

function draftCase(overrides: Partial<OnboardingCase> = {}): OnboardingCase {
  return {
    id: '00000000-0000-0000-0000-000000000010',
    idempotencyKey: 'alta-demo-0001',
    currentStep: 1,
    status: 'draft',
    organizer: null,
    sites: null,
    identity: null,
    billing: null,
    adminUser: null,
    actaHash: null,
    createdAt: '2026-09-24T10:00:00-05:00',
    updatedAt: '2026-09-24T10:00:00-05:00',
    ...overrides,
  };
}

function stepData(step: number): unknown {
  switch (step) {
    case 1:
      return ORGANIZER;
    case 2:
      return SITES;
    case 3:
      return IDENTITY;
    case 4:
      return BILLING_MANUAL;
    case 5:
      return ADMIN;
    case 6:
      return undefined;
    case 7:
      return { confirmed: true };
    default:
      throw new Error(`unknown step ${step}`);
  }
}

/** Walks the record up to (not including) `until`, applying no step twice. */
function walkTo(until: number, start: OnboardingCase = draftCase()): OnboardingCase {
  let record = start;
  for (let step = 1; step < until; step++) {
    const result = advance(record, { step, data: stepData(step) });
    assert.equal(result.ok, true, `step ${step} should be accepted`);
    if (result.ok) record = result.record;
  }
  return record;
}

describe('STEPS', () => {
  it('exposes exactly the 7 steps of §11, 1-indexed', () => {
    assert.deepEqual(Object.keys(STEPS), ['1', '2', '3', '4', '5', '6', '7']);
    for (let step = 1; step <= 7; step++) {
      assert.equal(STEPS[step as StepNumber].step, step);
      assert.equal(typeof STEPS[step as StepNumber].validate, 'function');
    }
  });
});

describe('advance — happy flow', () => {
  it('walks 1 -> 7 and issues an acta with a 64-hex sha256 hash', () => {
    let record = draftCase();
    const nextSteps: Array<number | null> = [];

    for (let step = 1; step <= 7; step++) {
      assert.equal(record.currentStep, step);
      const result = advance(record, { step, data: stepData(step) });
      assert.equal(result.ok, true, `step ${step} rejected`);
      if (!result.ok) return;
      nextSteps.push(result.nextStep);
      record = result.record;
      if (step < 7) assert.equal(result.acta, null);
      else {
        assert.notEqual(result.acta, null);
        assert.match(result.acta?.hash ?? '', /^[0-9a-f]{64}$/);
      }
    }

    assert.deepEqual(nextSteps, [2, 3, 4, 5, 6, 7, null]);
    assert.equal(record.status, 'closed');
    assert.match(record.actaHash ?? '', /^[0-9a-f]{64}$/);
    assert.deepEqual(record.organizer, ORGANIZER);
    assert.deepEqual(record.sites, SITES.sites);
    assert.deepEqual(record.identity, IDENTITY);
    assert.deepEqual(record.billing, BILLING_MANUAL);
    assert.deepEqual(record.adminUser, ADMIN);
  });

  it('produces a deterministic hash for the same payload', () => {
    const first = advance(walkTo(7), { step: 7, data: { confirmed: true } });
    const second = advance(walkTo(7), { step: 7, data: { confirmed: true } });
    assert.equal(first.ok && second.ok, true);
    if (first.ok && second.ok) assert.equal(first.acta?.hash, second.acta?.hash);
  });

  it('marks the case active while the wizard is still open', () => {
    const result = advance(draftCase(), { step: 1, data: ORGANIZER });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.record.status, 'active');
      assert.equal(result.nextStep, 2);
      assert.equal(result.audit.event, 'onboarding.step_confirmed');
    }
  });
});

describe('advance — rejections', () => {
  it('rejects a step submitted out of order', () => {
    const result = advance(draftCase(), { step: 2, data: SITES });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'step.out_of_order');
  });

  it('rejects replaying an already confirmed step', () => {
    const result = advance(walkTo(3), { step: 1, data: ORGANIZER });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'step.out_of_order');
  });

  it('rejects any step once the acta closed the case', () => {
    const closed = advance(walkTo(7), { step: 7, data: { confirmed: true } });
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    const result = advance(closed.record, { step: 1, data: ORGANIZER });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'case.closed');
  });

  it('blocks step 1 when the RUC check digit is invalid', () => {
    const wrongDigit = String((Number(computeCheckDigit('2012345678')) + 1) % 10);
    const result = advance(draftCase(), {
      step: 1,
      data: { ...ORGANIZER, ruc: `2012345678${wrongDigit}` },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'organizer.ruc_invalid');
  });

  it('blocks step 1 when the legal name or the fiscal address is missing', () => {
    const noName = advance(draftCase(), { step: 1, data: { ...ORGANIZER, legalName: '  ' } });
    const noAddress = advance(draftCase(), { step: 1, data: { ...ORGANIZER, fiscalAddress: '' } });
    assert.equal(noName.ok, false);
    assert.equal(noAddress.ok, false);
    if (!noName.ok) assert.equal(noName.reason, 'organizer.legal_name_missing');
    if (!noAddress.ok) assert.equal(noAddress.reason, 'organizer.address_missing');
  });

  it('blocks step 2 when an IPRESS has no valid ARCO mailbox', () => {
    const afterOrganizer = advance(draftCase(), { step: 1, data: ORGANIZER });
    assert.equal(afterOrganizer.ok, true);
    if (!afterOrganizer.ok) return;
    const result = advance(afterOrganizer.record, {
      step: 2,
      data: { sites: [{ ...SITES.sites[0], arcoEmail: 'arco.invalid' }] },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'site.arco_email_invalid');
  });

  it('blocks step 2 when no IPRESS is provided', () => {
    const result = advance(walkTo(2), { step: 2, data: { sites: [] } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'sites.empty');
  });

  it('requires an environment when billing switches to sunat_beta', () => {
    const record = walkTo(4);
    const withoutEnv = advance(record, { step: 4, data: { mode: 'sunat_beta' } });
    const withEnv = advance(record, {
      step: 4,
      data: { mode: 'sunat_beta', environment: 'beta' },
    });
    assert.equal(withoutEnv.ok, false);
    if (!withoutEnv.ok) assert.equal(withoutEnv.reason, 'billing.environment_missing');
    assert.equal(withEnv.ok, true);
  });

  it('rejects an unknown billing mode', () => {
    const result = advance(walkTo(4), { step: 4, data: { mode: 'sunat_prod' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'billing.mode_invalid');
  });

  it('blocks step 5 when the administrator has MFA inactive', () => {
    const result = advance(walkTo(5), { step: 5, data: { ...ADMIN, mfaEnrolled: false } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'admin.mfa_not_enrolled');
  });

  it('blocks step 5 when the administrator email is malformed', () => {
    const result = advance(walkTo(5), { step: 5, data: { ...ADMIN, email: 'admin.demo' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'admin.email_invalid');
  });

  it('accepts the review step without new data', () => {
    const result = advance(walkTo(6), { step: 6, data: undefined });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.nextStep, 7);
  });

  it('blocks step 7 without explicit confirmation', () => {
    const result = advance(walkTo(7), { step: 7, data: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'confirmation.required');
  });
});

describe('requireOnboarded', () => {
  it('blocks business routes until the acta exists', () => {
    assert.equal(requireOnboarded(false), 'onboarding_pending');
  });

  it('releases business routes after the acta exists', () => {
    assert.equal(requireOnboarded(true), 'ok');
  });
});

describe('resumeFrom', () => {
  it('resumes a draft case at its last confirmed step plus one', () => {
    assert.equal(resumeFrom(walkTo(3)), 3);
  });

  it('starts at step 1 without a stored case', () => {
    assert.equal(resumeFrom(null), 1);
    assert.equal(resumeFrom(undefined), 1);
    assert.equal(resumeFrom({ currentStep: 0, status: 'draft' }), 1);
  });

  it('reports the wizard as finished for a closed case', () => {
    assert.equal(resumeFrom({ currentStep: 7, status: 'closed' }), 7);
  });

  it('clamps an out-of-range stored step to the last step', () => {
    assert.equal(resumeFrom({ currentStep: 99, status: 'draft' }), 7);
  });
});

describe('canonicalJson', () => {
  it('is stable regardless of key insertion order', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  });

  it('keeps array order and nested structure', () => {
    assert.equal(canonicalJson({ a: [1, { z: 1, y: 2 }] }), '{"a":[1,{"y":2,"z":1}]}');
  });
});
