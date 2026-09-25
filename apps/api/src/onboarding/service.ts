// Onboarding state machine — first-run wizard (peru-anexo-v1.md §11).
// Trigger: the database is empty (zero tenants, or app_state without
// initialized_at); the wizard runs once and does not reopen for a tenant that
// is already initialized.
//
// Pure by design: no database access and no clock. The caller persists the
// returned record, stamps updated_at, and writes one audit_log row per
// confirmed step (the `audit` field of an accepted advance).
import { createHash } from 'node:crypto';
import { validateRUC } from './ruc.ts';

// ============ step shapes ============

export interface OrganizerData {
  legalName: string;
  ruc: string;
  fiscalAddress: string;
}

export interface SiteData {
  name: string;
  address: string;
  arcoEmail: string;
}

export interface IdentityData {
  visibleName: string;
  responsible: string;
  logoUrl?: string;
}

export interface BillingData {
  mode: 'manual' | 'sunat_beta';
  environment?: string;
}

export interface AdminData {
  username: string;
  email: string;
  mfaEnrolled: boolean;
}

export type CaseStatus = 'draft' | 'active' | 'closed';

export interface OnboardingCase {
  id: string;
  idempotencyKey: string;
  currentStep: number;
  status: CaseStatus;
  organizer: OrganizerData | null;
  sites: SiteData[] | null;
  identity: IdentityData | null;
  billing: BillingData | null;
  adminUser: AdminData | null;
  actaHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingActa {
  hash: string;
  payload: {
    organizer: OrganizerData | null;
    sites: SiteData[] | null;
    identity: IdentityData | null;
    billing: BillingData | null;
    adminUser: AdminData | null;
    idempotencyKey: string;
  };
}

// ============ validation primitives ============

export interface ValidationResult {
  ok: boolean;
  reason: string;
}

export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type StepKey =
  | 'organizer'
  | 'sites'
  | 'identity'
  | 'billing'
  | 'admin'
  | 'review'
  | 'confirmation';

export interface StepDefinition {
  step: StepNumber;
  key: StepKey;
  title: string;
  validate: (data: unknown) => ValidationResult;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LAST_STEP: StepNumber = 7;

function accepted(): ValidationResult {
  return { ok: true, reason: 'ok' };
}

function rejected(reason: string): ValidationResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ============ per-step validators ============

/** Step 1 — organizer: legal name, RUC with valid check digit, fiscal address. */
export function validateOrganizer(data: unknown): ValidationResult {
  if (!isRecord(data)) return rejected('organizer.missing');
  if (!isFilled(data.legalName)) return rejected('organizer.legal_name_missing');
  if (!isFilled(data.ruc) || !validateRUC(data.ruc)) return rejected('organizer.ruc_invalid');
  if (!isFilled(data.fiscalAddress)) return rejected('organizer.address_missing');
  return accepted();
}

/** Step 2 — at least one IPRESS with name, address and a valid ARCO mailbox. */
export function validateSites(data: unknown): ValidationResult {
  if (!isRecord(data) || !Array.isArray(data.sites)) return rejected('sites.missing');
  if (data.sites.length < 1) return rejected('sites.empty');
  for (const site of data.sites) {
    if (!isRecord(site)) return rejected('site.missing');
    if (!isFilled(site.name)) return rejected('site.name_missing');
    if (!isFilled(site.address)) return rejected('site.address_missing');
    if (!isFilled(site.arcoEmail) || !EMAIL.test(site.arcoEmail)) {
      return rejected('site.arco_email_invalid');
    }
  }
  return accepted();
}

/** Step 3 — visible name and data-protection officer (ARCO responsible). */
export function validateIdentity(data: unknown): ValidationResult {
  if (!isRecord(data)) return rejected('identity.missing');
  if (!isFilled(data.visibleName)) return rejected('identity.visible_name_missing');
  if (!isFilled(data.responsible)) return rejected('identity.responsible_missing');
  return accepted();
}

/** Step 4 — manual billing by default; sunat_beta requires an environment. */
export function validateBilling(data: unknown): ValidationResult {
  if (!isRecord(data)) return rejected('billing.missing');
  if (data.mode !== 'manual' && data.mode !== 'sunat_beta') {
    return rejected('billing.mode_invalid');
  }
  if (data.mode === 'sunat_beta' && !isFilled(data.environment)) {
    return rejected('billing.environment_missing');
  }
  return accepted();
}

/** Step 5 — administrator with mandatory MFA already enrolled. */
export function validateAdmin(data: unknown): ValidationResult {
  if (!isRecord(data)) return rejected('admin.missing');
  if (!isFilled(data.username)) return rejected('admin.username_missing');
  if (!isFilled(data.email) || !EMAIL.test(data.email)) return rejected('admin.email_invalid');
  if (data.mfaEnrolled !== true) return rejected('admin.mfa_not_enrolled');
  return accepted();
}

/** Step 6 — review: only confirms what earlier steps already captured. */
export function validateReview(_data: unknown): ValidationResult {
  return accepted();
}

/** Step 7 — confirmation of the final acta. */
export function validateConfirmation(data: unknown): ValidationResult {
  if (!isRecord(data) || data.confirmed !== true) return rejected('confirmation.required');
  return accepted();
}

// ============ the 7-step table (§11), 1-indexed ============

export const STEPS: Readonly<Record<StepNumber, StepDefinition>> = {
  1: { step: 1, key: 'organizer', title: 'Organizer', validate: validateOrganizer },
  2: { step: 2, key: 'sites', title: 'IPRESS sites', validate: validateSites },
  3: { step: 3, key: 'identity', title: 'Identity', validate: validateIdentity },
  4: { step: 4, key: 'billing', title: 'Billing', validate: validateBilling },
  5: { step: 5, key: 'admin', title: 'Administrator', validate: validateAdmin },
  6: { step: 6, key: 'review', title: 'Review', validate: validateReview },
  7: { step: 7, key: 'confirmation', title: 'Confirmation', validate: validateConfirmation },
};

// ============ canonical JSON + acta hash ============

/** Deterministic JSON: object keys sorted, array order preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const body = Object.keys(source)
      .sort()
      .filter((key) => source[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// ============ advance ============

export interface StepSubmission {
  step: number;
  data?: unknown;
}

export interface AdvanceAccepted {
  ok: true;
  record: OnboardingCase;
  nextStep: number | null;
  acta: OnboardingActa | null;
  audit: { step: number; event: string };
}

export interface AdvanceRejected {
  ok: false;
  reason: string;
}

export type AdvanceResult = AdvanceAccepted | AdvanceRejected;

function applyStep(record: OnboardingCase, key: StepKey, data: unknown): OnboardingCase {
  switch (key) {
    case 'organizer':
      return { ...record, organizer: data as OrganizerData };
    case 'sites':
      return { ...record, sites: (data as { sites: SiteData[] }).sites };
    case 'identity':
      return { ...record, identity: data as IdentityData };
    case 'billing':
      return { ...record, billing: data as BillingData };
    case 'admin':
      return { ...record, adminUser: data as AdminData };
    default:
      // review and confirmation capture no new data
      return record;
  }
}

function buildActa(record: OnboardingCase): OnboardingActa {
  const payload: OnboardingActa['payload'] = {
    organizer: record.organizer,
    sites: record.sites,
    identity: record.identity,
    billing: record.billing,
    adminUser: record.adminUser,
    idempotencyKey: record.idempotencyKey,
  };
  return { hash: sha256Hex(payload), payload };
}

/**
 * Confirms the current step and returns the next state.
 * Only the step the case is currently on is accepted; a case whose acta was
 * already issued is closed for good.
 */
export function advance(record: OnboardingCase, submission: StepSubmission): AdvanceResult {
  if (record.status === 'closed') return { ok: false, reason: 'case.closed' };
  if (
    !isRecord(submission) ||
    submission.step !== record.currentStep ||
    !Number.isInteger(submission.step)
  ) {
    return { ok: false, reason: 'step.out_of_order' };
  }

  const step = STEPS[record.currentStep as StepNumber];
  if (!step) return { ok: false, reason: 'step.out_of_range' };

  const verdict = step.validate(submission.data);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const withData = applyStep(record, step.key, submission.data);
  const audit = { step: record.currentStep, event: 'onboarding.step_confirmed' };

  if (record.currentStep >= LAST_STEP) {
    const acta = buildActa(withData);
    return {
      ok: true,
      record: { ...withData, status: 'closed', actaHash: acta.hash },
      nextStep: null,
      acta,
      audit,
    };
  }

  return {
    ok: true,
    record: { ...withData, currentStep: record.currentStep + 1, status: 'active' },
    nextStep: record.currentStep + 1,
    acta: null,
    audit,
  };
}

// ============ route gate + resume ============

/** §11 bloqueo de rutas: until the acta closes, business routes answer pending. */
export function requireOnboarded(initialized: boolean): 'ok' | 'onboarding_pending' {
  return initialized ? 'ok' : 'onboarding_pending';
}

/** §11 reanudación: the step the wizard must reopen on. */
export function resumeFrom(
  stored: Pick<OnboardingCase, 'currentStep' | 'status'> | null | undefined,
): number {
  if (!stored) return 1;
  if (stored.status === 'closed') return LAST_STEP;
  const step = Number(stored.currentStep);
  if (!Number.isInteger(step) || step < 1) return 1;
  return Math.min(step, LAST_STEP);
}
