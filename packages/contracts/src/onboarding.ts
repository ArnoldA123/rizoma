// Onboarding HTTP contracts — Zod mirrors of `apps/api/src/onboarding/*`
// (peru-anexo-v1.md §11, first-run wizard).
//
// The API service owns the domain validation and its `reason` strings; these
// schemas are the transport mirror the web client pre-flights with, so an
// invalid payload is refused in the browser with the local rule instead of
// costing a round trip. Field-for-field, step 1 validates the organizer
// (legal name, 11-digit RUC, fiscal address), step 2 the IPRESS list with its
// ARCO mailboxes, step 3 the visible identity, step 4 the billing mode,
// step 5 the administrator with MFA already enrolled, step 6 accepts anything
// (review captures no new data) and step 7 requires explicit confirmation.
//
// Self-contained on purpose: the module imports only `zod` and carries its own
// UUID/SHA-256/RUC shapes, so `common.ts` can re-export it without creating an
// import cycle (`common.ts` already re-exports this module for the public
// `@rizoma/contracts` entry point).
import { z, type ZodType } from 'zod';

/** Canonical UUID shape, mirroring `uuidSchema` in `./common.ts`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lowercase SHA-256 hex digest produced for the signed acta. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** RUC shape (11 digits); the check digit stays an API authority. */
const RUC_RE = /^\d{11}$/;

/** Mailbox shape for the ARCO and administrator addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Non-empty after trimming, the same rule the API applies to free text. */
const nonEmptyTextSchema = z
  .string()
  .refine((value) => value.trim() !== '', 'Expected non-empty text');

/** UUID string. */
const uuidSchema = z.string().regex(UUID_RE, 'Expected a UUID');

/** Step 1 — organizer: legal name, RUC shape, fiscal address. */
export const onboardingOrganizerSchema = z.object({
  legalName: nonEmptyTextSchema,
  ruc: z.string().regex(RUC_RE, 'Expected an 11-digit RUC'),
  fiscalAddress: nonEmptyTextSchema,
});
export type OnboardingOrganizer = z.infer<typeof onboardingOrganizerSchema>;

/** One IPRESS site with its ARCO mailbox. */
export const onboardingSiteSchema = z.object({
  name: nonEmptyTextSchema,
  address: nonEmptyTextSchema,
  arcoEmail: z.string().regex(EMAIL_RE, 'Expected a valid mailbox'),
});
export type OnboardingSite = z.infer<typeof onboardingSiteSchema>;

/** Step 2 — at least one IPRESS site. */
export const onboardingSitesInputSchema = z.object({
  sites: z.array(onboardingSiteSchema).min(1),
});
export type OnboardingSitesInput = z.infer<typeof onboardingSitesInputSchema>;

/** Step 3 — visible name and data-protection (ARCO) responsible. */
export const onboardingIdentityInputSchema = z.object({
  visibleName: nonEmptyTextSchema,
  responsible: nonEmptyTextSchema,
  logoUrl: z.string().min(1).optional(),
});
export type OnboardingIdentityInput = z.infer<typeof onboardingIdentityInputSchema>;

/** Billing modes the API accepts. */
export const ONBOARDING_BILLING_MODES = ['manual', 'sunat_beta'] as const;
export const onboardingBillingModeSchema = z.enum(ONBOARDING_BILLING_MODES);
export type OnboardingBillingMode = z.infer<typeof onboardingBillingModeSchema>;

/**
 * Step 4 — manual billing by default; `sunat_beta` requires an environment,
 * mirroring `validateBilling` in the API service.
 */
export const onboardingBillingInputSchema = z
  .object({
    mode: onboardingBillingModeSchema,
    environment: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      value.mode !== 'sunat_beta' ||
      (value.environment !== undefined && value.environment.trim() !== ''),
    { message: 'sunat_beta requires an environment', path: ['environment'] },
  );
export type OnboardingBillingInput = z.infer<typeof onboardingBillingInputSchema>;

/** Step 5 — administrator with MFA already enrolled. */
export const onboardingAdminInputSchema = z.object({
  username: nonEmptyTextSchema,
  email: z.string().regex(EMAIL_RE, 'Expected a valid mailbox'),
  mfaEnrolled: z.boolean().refine((value) => value === true, 'MFA must be enrolled'),
});
export type OnboardingAdminInput = z.infer<typeof onboardingAdminInputSchema>;

/** Step 6 — review captures no new data; anything (including absent) passes. */
export const onboardingReviewInputSchema: ZodType<unknown> = z.unknown();
export type OnboardingReviewInput = unknown;

/** Step 7 — explicit confirmation of the final acta. */
export const onboardingConfirmationInputSchema = z.object({
  confirmed: z.boolean().refine((value) => value === true, 'Confirmation is required'),
});
export type OnboardingConfirmationInput = z.infer<typeof onboardingConfirmationInputSchema>;

/** Case lifecycle states, mirroring the `onboarding_cases.status` CHECK. */
export const ONBOARDING_CASE_STATUSES = ['draft', 'active', 'closed'] as const;
export const onboardingCaseStatusSchema = z.enum(ONBOARDING_CASE_STATUSES);
export type OnboardingCaseStatus = z.infer<typeof onboardingCaseStatusSchema>;

/** Last wizard step. */
export const LAST_ONBOARDING_STEP = 7;

/** Step catalogue: number, stable key and English title. */
export const ONBOARDING_STEPS = [
  { step: 1, key: 'organizer', title: 'Organizer' },
  { step: 2, key: 'sites', title: 'IPRESS sites' },
  { step: 3, key: 'identity', title: 'Identity' },
  { step: 4, key: 'billing', title: 'Billing' },
  { step: 5, key: 'admin', title: 'Administrator' },
  { step: 6, key: 'review', title: 'Review' },
  { step: 7, key: 'confirmation', title: 'Confirmation' },
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];

/** Key of a wizard step number, or `null` when out of range. */
export function onboardingStepKey(step: number): OnboardingStepKey | null {
  return ONBOARDING_STEPS.find((entry) => entry.step === step)?.key ?? null;
}

/**
 * Pre-flight schema of one step payload — the same validator the API service
 * applies. Out-of-range steps answer a never-passing schema so the client
 * refuses them before any round trip.
 */
export function onboardingStepInputSchema(step: number): ZodType<unknown> {
  switch (step) {
    case 1:
      return onboardingOrganizerSchema;
    case 2:
      return onboardingSitesInputSchema;
    case 3:
      return onboardingIdentityInputSchema;
    case 4:
      return onboardingBillingInputSchema;
    case 5:
      return onboardingAdminInputSchema;
    case 6:
      return onboardingReviewInputSchema;
    case 7:
      return onboardingConfirmationInputSchema;
    default:
      return z.never();
  }
}

/**
 * `onboarding_cases` row as the API emits it (camelCase, JSONB columns parsed,
 * timestamps as plain strings).
 */
export const onboardingCaseSchema = z.object({
  id: uuidSchema,
  idempotencyKey: z.string().min(1),
  currentStep: z.number().int().min(1).max(LAST_ONBOARDING_STEP),
  status: onboardingCaseStatusSchema,
  organizer: onboardingOrganizerSchema.nullable(),
  sites: z.array(onboardingSiteSchema).nullable(),
  identity: onboardingIdentityInputSchema.nullable(),
  billing: onboardingBillingInputSchema.nullable(),
  adminUser: onboardingAdminInputSchema.nullable(),
  actaHash: z.string().regex(SHA256_RE, 'Expected a SHA-256 hex digest').nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type OnboardingCase = z.infer<typeof onboardingCaseSchema>;

/**
 * `GET /v1/onboarding/status` — whether the first run already closed, the open
 * case when there is one, and the step the wizard must reopen on (`null` once
 * the acta closed the case).
 */
export const onboardingStatusResponseSchema = z.object({
  initialized: z.boolean(),
  case: onboardingCaseSchema.nullable(),
  nextStep: z.number().int().min(1).max(LAST_ONBOARDING_STEP).nullable(),
});
export type OnboardingStatusResponse = z.infer<typeof onboardingStatusResponseSchema>;

/** `GET /v1/onboarding/resume` — the open case plus the step to reopen on. */
export const onboardingResumeResponseSchema = onboardingStatusResponseSchema;
export type OnboardingResumeResponse = z.infer<typeof onboardingResumeResponseSchema>;

/** Signed acta payload: everything the wizard captured plus the replay key. */
export const onboardingActaPayloadSchema = z.object({
  organizer: onboardingOrganizerSchema.nullable(),
  sites: z.array(onboardingSiteSchema).nullable(),
  identity: onboardingIdentityInputSchema.nullable(),
  billing: onboardingBillingInputSchema.nullable(),
  adminUser: onboardingAdminInputSchema.nullable(),
  idempotencyKey: z.string().min(1),
});
export type OnboardingActaPayload = z.infer<typeof onboardingActaPayloadSchema>;

/** `GET /v1/onboarding/acta` — the signed acta with its SHA-256 hash. */
export const onboardingActaSchema = z.object({
  hash: z.string().regex(SHA256_RE, 'Expected a SHA-256 hex digest'),
  payload: onboardingActaPayloadSchema,
});
export type OnboardingActa = z.infer<typeof onboardingActaSchema>;

/**
 * `POST /v1/onboarding/steps/:n` — the confirmed step, the step to open next
 * (`null` once the acta closed the case) and the acta on the final step.
 */
export const onboardingStepResponseSchema = z.object({
  case: onboardingCaseSchema,
  nextStep: z.number().int().min(1).max(LAST_ONBOARDING_STEP).nullable(),
  acta: onboardingActaSchema.nullable(),
});
export type OnboardingStepResponse = z.infer<typeof onboardingStepResponseSchema>;

/**
 * Body of `POST /v1/onboarding/steps/:n`: the step payload under `data` and an
 * optional idempotency key used only when the call opens the case. A replay key
 * sent on later steps is accepted and ignored — the case key is immutable.
 */
export const onboardingStepSubmitSchema = z.object({
  data: z.unknown().optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type OnboardingStepSubmit = z.infer<typeof onboardingStepSubmitSchema>;
