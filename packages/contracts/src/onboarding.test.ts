// Onboarding contract tests — synthetic payloads only, no live API involved.
//
// They protect the H3 transport mirror: every step pre-flight accepts what the
// API service accepts and refuses what it refuses, and the four endpoint
// envelopes match the shapes the controller emits. Runner:
// `node --test src/onboarding.test.ts` (type stripping). Demo RUC 20123456789
// is synthetic, like every other fixture in this package.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LAST_ONBOARDING_STEP,
  ONBOARDING_STEPS,
  onboardingActaSchema,
  onboardingAdminInputSchema,
  onboardingBillingInputSchema,
  onboardingCaseSchema,
  onboardingConfirmationInputSchema,
  onboardingIdentityInputSchema,
  onboardingOrganizerSchema,
  onboardingResumeResponseSchema,
  onboardingSitesInputSchema,
  onboardingStatusResponseSchema,
  onboardingStepInputSchema,
  onboardingStepKey,
  onboardingStepResponseSchema,
  onboardingStepSubmitSchema,
} from './onboarding.ts';

/** Synthetic RUC shape used across the fixtures (format only). */
const DEMO_RUC = '20123456789';

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
  ],
};

const IDENTITY = { visibleName: 'Demo Salud', responsible: 'Dra. Demo Responsable' };
const BILLING = { mode: 'manual' } as const;
const ADMIN = {
  username: 'admin.demo',
  email: 'admin.demo@example.invalid',
  mfaEnrolled: true,
};

const CASE_ID = '00000000-0000-4000-8000-000000000010';

function openCase(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    idempotencyKey: 'alta-demo-0001',
    currentStep: 3,
    status: 'active',
    organizer: ORGANIZER,
    sites: SITES.sites,
    identity: null,
    billing: null,
    adminUser: null,
    actaHash: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

test('catalog exposes the 7 steps of §11 with stable keys', () => {
  assert.equal(LAST_ONBOARDING_STEP, 7);
  assert.deepEqual(
    ONBOARDING_STEPS.map((entry) => entry.step),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(onboardingStepKey(1), 'organizer');
  assert.equal(onboardingStepKey(7), 'confirmation');
  assert.equal(onboardingStepKey(9), null);
});

test('organizer accepts the demo shape and refuses a malformed RUC', () => {
  assert.equal(onboardingOrganizerSchema.safeParse(ORGANIZER).success, true);
  assert.equal(
    onboardingOrganizerSchema.safeParse({ ...ORGANIZER, ruc: '2012345678' }).success,
    false,
  );
  assert.equal(
    onboardingOrganizerSchema.safeParse({ ...ORGANIZER, legalName: '  ' }).success,
    false,
  );
  assert.equal(
    onboardingOrganizerSchema.safeParse({ ...ORGANIZER, fiscalAddress: '' }).success,
    false,
  );
});

test('sites need one IPRESS with a valid ARCO mailbox', () => {
  assert.equal(onboardingSitesInputSchema.safeParse(SITES).success, true);
  assert.equal(onboardingSitesInputSchema.safeParse({ sites: [] }).success, false);
  assert.equal(
    onboardingSitesInputSchema.safeParse({
      sites: [{ ...SITES.sites[0], arcoEmail: 'arco.invalid' }],
    }).success,
    false,
  );
  assert.equal(
    onboardingSitesInputSchema.safeParse({
      sites: [{ ...SITES.sites[0], name: '  ' }],
    }).success,
    false,
  );
});

test('identity needs a visible name and a responsible', () => {
  assert.equal(onboardingIdentityInputSchema.safeParse(IDENTITY).success, true);
  assert.equal(
    onboardingIdentityInputSchema.safeParse({ ...IDENTITY, visibleName: '' }).success,
    false,
  );
  assert.equal(
    onboardingIdentityInputSchema.safeParse({ ...IDENTITY, responsible: '  ' }).success,
    false,
  );
  assert.equal(
    onboardingIdentityInputSchema.safeParse({ ...IDENTITY, logoUrl: 'https://demo.invalid/logo.png' })
      .success,
    true,
  );
});

test('billing defaults to manual and asks for an environment on sunat_beta', () => {
  assert.equal(onboardingBillingInputSchema.safeParse(BILLING).success, true);
  assert.equal(
    onboardingBillingInputSchema.safeParse({ mode: 'sunat_beta' }).success,
    false,
  );
  assert.equal(
    onboardingBillingInputSchema.safeParse({ mode: 'sunat_beta', environment: 'beta' }).success,
    true,
  );
  assert.equal(onboardingBillingInputSchema.safeParse({ mode: 'sunat_prod' }).success, false);
});

test('admin requires a mailbox and an enrolled MFA', () => {
  assert.equal(onboardingAdminInputSchema.safeParse(ADMIN).success, true);
  assert.equal(
    onboardingAdminInputSchema.safeParse({ ...ADMIN, mfaEnrolled: false }).success,
    false,
  );
  assert.equal(
    onboardingAdminInputSchema.safeParse({ ...ADMIN, email: 'admin.demo' }).success,
    false,
  );
});

test('confirmation requires an explicit opt-in', () => {
  assert.equal(onboardingConfirmationInputSchema.safeParse({ confirmed: true }).success, true);
  assert.equal(onboardingConfirmationInputSchema.safeParse({}).success, false);
  assert.equal(
    onboardingConfirmationInputSchema.safeParse({ confirmed: false }).success,
    false,
  );
});

test('step router mirrors the service validators, review included', () => {
  assert.equal(onboardingStepInputSchema(1).safeParse(ORGANIZER).success, true);
  assert.equal(onboardingStepInputSchema(1).safeParse({}).success, false);
  assert.equal(onboardingStepInputSchema(2).safeParse(SITES).success, true);
  assert.equal(onboardingStepInputSchema(4).safeParse({ mode: 'sunat_beta' }).success, false);
  assert.equal(onboardingStepInputSchema(5).safeParse(ADMIN).success, true);
  // Review captures no new data: absent and arbitrary payloads both pass.
  assert.equal(onboardingStepInputSchema(6).safeParse(undefined).success, true);
  assert.equal(onboardingStepInputSchema(6).safeParse({ anything: 1 }).success, true);
  assert.equal(onboardingStepInputSchema(7).safeParse({ confirmed: true }).success, true);
  assert.equal(onboardingStepInputSchema(7).safeParse({}).success, false);
  // Out of range never passes, so the client refuses it before any round trip.
  assert.equal(onboardingStepInputSchema(0).safeParse({}).success, false);
  assert.equal(onboardingStepInputSchema(9).safeParse({}).success, false);
});

test('case schema accepts an open row and a closed row with its acta hash', () => {
  assert.equal(onboardingCaseSchema.safeParse(openCase()).success, true);
  const closed = openCase({
    currentStep: 7,
    status: 'closed',
    identity: IDENTITY,
    billing: BILLING,
    adminUser: ADMIN,
    actaHash: 'a'.repeat(64),
  });
  const parsed = onboardingCaseSchema.parse(closed);
  assert.equal(parsed.status, 'closed');
  assert.equal(
    onboardingCaseSchema.safeParse({ ...openCase(), currentStep: 9 }).success,
    false,
  );
  assert.equal(
    onboardingCaseSchema.safeParse({ ...openCase(), actaHash: 'not-a-hash' }).success,
    false,
  );
});

test('status and resume share one envelope: flag, nullable case, nullable step', () => {
  const empty = onboardingStatusResponseSchema.parse({
    initialized: false,
    case: null,
    nextStep: 1,
  });
  assert.equal(empty.nextStep, 1);

  const resumed = onboardingResumeResponseSchema.parse({
    initialized: false,
    case: openCase(),
    nextStep: 3,
  });
  assert.equal(resumed.case?.currentStep, 3);

  const done = onboardingStatusResponseSchema.parse({
    initialized: true,
    case: openCase({ status: 'closed', actaHash: 'b'.repeat(64) }),
    nextStep: null,
  });
  assert.equal(done.initialized, true);
  assert.equal(done.nextStep, null);
});

test('step response carries the case, the next step and the nullable acta', () => {
  const mid = onboardingStepResponseSchema.parse({
    case: openCase(),
    nextStep: 4,
    acta: null,
  });
  assert.equal(mid.nextStep, 4);
  assert.equal(mid.acta, null);

  const fin = onboardingStepResponseSchema.parse({
    case: openCase({ status: 'closed', actaHash: 'c'.repeat(64) }),
    nextStep: null,
    acta: {
      hash: 'c'.repeat(64),
      payload: {
        organizer: ORGANIZER,
        sites: SITES.sites,
        identity: IDENTITY,
        billing: BILLING,
        adminUser: ADMIN,
        idempotencyKey: 'alta-demo-0001',
      },
    },
  });
  assert.match(fin.acta?.hash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(
    onboardingActaSchema.safeParse({ ...fin.acta, hash: 'short' }).success,
    false,
  );
});

test('submit body keeps the data envelope and the optional replay key', () => {
  assert.deepEqual(onboardingStepSubmitSchema.parse({ data: ORGANIZER }), {
    data: ORGANIZER,
  });
  assert.equal(
    onboardingStepSubmitSchema.parse({ data: undefined, idempotencyKey: 'alta-demo-0001' })
      .idempotencyKey,
    'alta-demo-0001',
  );
  assert.equal(onboardingStepSubmitSchema.safeParse({ idempotencyKey: '' }).success, false);
});
