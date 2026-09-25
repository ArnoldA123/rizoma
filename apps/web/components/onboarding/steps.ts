// Wizard step metadata — the static half of the first-run onboarding screen.
//
// Pure and dependency-free, so it stays unit testable and usable from the
// client wizard without pulling the API client in. The runtime half (status,
// submit, acta) lives in `lib/onboarding-api.ts`; this module only describes
// the seven steps of peru-anexo-v1.md §11 in wizard order: which step is
// which, what an empty payload looks like, and the Spanish copy the screen
// renders (identifiers stay English, UI copy follows the project convention).
//
// The demo placeholder values are synthetic and never submitted as-is: the RUC
// placeholder shows the mandated demo shape `20123456789`, but the API checks
// the SUNAT digit, so the wizard ships empty fields and the operator types a
// check-valid value.
import { ONBOARDING_STEPS, type OnboardingStepKey } from '@rizoma/contracts';

/** One wizard step as the screen renders it. */
export interface WizardStep {
  readonly step: number;
  readonly key: OnboardingStepKey;
  readonly title: string;
  readonly description: string;
}

/** Copy of the seven steps in wizard order. */
export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    step: 1,
    key: 'organizer',
    title: 'Organización',
    description: 'Razón social, RUC con dígito verificador y domicilio fiscal.',
  },
  {
    step: 2,
    key: 'sites',
    title: 'Sedes IPRESS',
    description: 'Al menos una sede con dirección y casilla ARCO válida.',
  },
  {
    step: 3,
    key: 'identity',
    title: 'Identidad',
    description: 'Nombre visible y responsable de protección de datos.',
  },
  {
    step: 4,
    key: 'billing',
    title: 'Facturación',
    description: 'Emisión manual por defecto; el modo beta pide un entorno.',
  },
  {
    step: 5,
    key: 'admin',
    title: 'Administración',
    description: 'Cuenta administradora con MFA ya enrolado.',
  },
  {
    step: 6,
    key: 'review',
    title: 'Revisión',
    description: 'Confirma lo capturado antes de firmar el acta.',
  },
  {
    step: 7,
    key: 'confirmation',
    title: 'Confirmación',
    description: 'Firma del acta: el alta queda cerrada e inmutable.',
  },
];

/** True when the catalogue above still mirrors the contract catalogue. */
export function wizardMirrorsContract(): boolean {
  if (WIZARD_STEPS.length !== ONBOARDING_STEPS.length) return false;
  return WIZARD_STEPS.every(
    (entry, index) =>
      entry.step === ONBOARDING_STEPS[index]?.step && entry.key === ONBOARDING_STEPS[index]?.key,
  );
}

/** Empty payload of a step, used to reset its form. */
export function emptyStepPayload(step: number): Record<string, unknown> {
  switch (step) {
    case 1:
      return { legalName: '', ruc: '', fiscalAddress: '' };
    case 2:
      return { sites: [{ name: '', address: '', arcoEmail: '' }] };
    case 3:
      return { visibleName: '', responsible: '', logoUrl: '' };
    case 4:
      return { mode: 'manual', environment: '' };
    case 5:
      return { username: '', email: '', mfaEnrolled: false };
    case 6:
      return {};
    case 7:
      return { confirmed: false };
    default:
      return {};
  }
}

/** Synthetic placeholder RUC shown in the form (shape demo, not submittable). */
export const DEMO_RUC_PLACEHOLDER = '20123456789';
