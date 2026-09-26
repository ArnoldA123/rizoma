'use client';

import { useEffect, useState } from 'react';
import type { OnboardingActa } from '@rizoma/contracts';
import { ApiRequestError } from '@/lib/api-client';
import { getOnboardingStatus, submitOnboardingStep } from '@/lib/onboarding-api';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DEMO_RUC_PLACEHOLDER, WIZARD_STEPS, emptyStepPayload } from './steps';
import { cn } from '@/lib/utils';

/** Renderable failure: the four envelope facts, never tenant data. */
interface WizardFailure {
  readonly code: string;
  readonly message: string;
  readonly reason: string | null;
  readonly traceId: string | null;
}

function failureOf(error: unknown): WizardFailure {
  if (error instanceof ApiRequestError) {
    return { code: error.code, message: error.message, reason: error.reason ?? null, traceId: error.traceId };
  }
  return {
    code: 'client.invalid_step',
    message: error instanceof Error ? error.message : 'La solicitud no se llegó a enviar.',
    reason: null,
    traceId: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Collapsed technical detail with a copy affordance (P1-1 `CopyDetail`
 * pattern, duplicated here on purpose: sharing it would touch files outside
 * the P1 surfaces). The machine fields live only inside this collapsible.
 */
function CopyDetail({ failure }: { readonly failure: WizardFailure }) {
  const [copied, setCopied] = useState(false);
  const text = `code: ${failure.code}\nreason: ${failure.reason ?? '\u2014'}\ntraceId: ${failure.traceId ?? '\u2014'}`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
  }

  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
        Copiar detalle
      </summary>
      <dl className="tabular mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">code</dt>
        <dd className="font-mono break-all">{failure.code}</dd>
        <dt className="text-muted-foreground">reason</dt>
        <dd className="font-mono break-all">{failure.reason ?? '\u2014'}</dd>
        <dt className="text-muted-foreground">traceId</dt>
        <dd className="font-mono break-all">{failure.traceId ?? '\u2014'}</dd>
      </dl>
      <button
        type="button"
        onClick={() => void copy()}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-2')}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </details>
  );
}

interface SiteDraft {
  name: string;
  address: string;
  arcoEmail: string;
}

const EMPTY_SITE: SiteDraft = { name: '', address: '', arcoEmail: '' };

/**
 * First-run onboarding wizard — the seven steps of peru-anexo-v1.md §11.
 *
 * Public by design: the run happens before any tenant exists (pre-tenant
 * setup, migration 002), so there is no session to guard with and no tenant
 * fact to carry. The component loads the gate flag on mount, reopens the
 * wizard on the stored step, confirms one step per click (a fresh
 * `Idempotency-Key` per intent, owned by `lib/onboarding-api.ts`) and ends on
 * the signed acta with its SHA-256 hash.
 */
export function OnboardingWizard() {
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [loadFailure, setLoadFailure] = useState<WizardFailure | null>(null);
  const [finished, setFinished] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [snapshots, setSnapshots] = useState<Readonly<Record<number, unknown>>>({});
  const [draft, setDraft] = useState<Record<string, unknown>>(() => emptyStepPayload(1));
  const [sites, setSites] = useState<SiteDraft[]>([{ ...EMPTY_SITE }]);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailure, setSubmitFailure] = useState<WizardFailure | null>(null);
  const [acta, setActa] = useState<OnboardingActa | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const status = await getOnboardingStatus();
        if (cancelled) return;
        if (status.initialized) {
          setFinished(true);
          setPhase('ready');
          return;
        }
        const step = status.nextStep ?? 1;
        const record = status.case;
        if (record !== null) {
          const confirmed: Record<number, unknown> = {};
          if (record.organizer !== null) confirmed[1] = record.organizer;
          if (record.sites !== null) {
            confirmed[2] = { sites: record.sites };
            setSites(
              record.sites.length > 0
                ? record.sites.map((site) => ({ ...EMPTY_SITE, ...site }))
                : [{ ...EMPTY_SITE }],
            );
          }
          if (record.identity !== null) confirmed[3] = record.identity;
          if (record.billing !== null) confirmed[4] = record.billing;
          if (record.adminUser !== null) confirmed[5] = record.adminUser;
          setSnapshots(confirmed);
        }
        setCurrentStep(step);
        setDraft({ ...emptyStepPayload(step), ...asRecord(confirmedStep(record, step)) });
        setPhase('ready');
      } catch (error) {
        if (!cancelled) {
          setLoadFailure(failureOf(error));
          setPhase('ready');
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function confirmedStep(record: { organizer: unknown; sites: unknown; identity: unknown; billing: unknown; adminUser: unknown } | null, step: number): unknown {
    if (record === null) return undefined;
    switch (step) {
      case 1:
        return record.organizer ?? undefined;
      case 2:
        return record.sites === null ? undefined : { sites: record.sites };
      case 3:
        return record.identity ?? undefined;
      case 4:
        return record.billing ?? undefined;
      case 5:
        return record.adminUser ?? undefined;
      default:
        return undefined;
    }
  }

  function openStep(step: number, confirmed: Readonly<Record<number, unknown>>): void {
    setCurrentStep(step);
    setDraft({ ...emptyStepPayload(step), ...asRecord(confirmed[step]) });
    if (step === 2) {
      const saved = asRecord(confirmed[2]).sites;
      setSites(
        Array.isArray(saved) && saved.length > 0
          ? (saved as SiteDraft[]).map((site) => ({ ...EMPTY_SITE, ...site }))
          : [{ ...EMPTY_SITE }],
      );
    }
    setSubmitFailure(null);
  }

  function setField(key: string, value: unknown): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  /** Normalizes the draft into the payload the step contract expects. */
  function payloadFor(step: number): unknown {
    if (step === 2) return { sites };
    if (step === 3) {
      const logoUrl = textOf(draft.logoUrl).trim();
      return {
        visibleName: draft.visibleName,
        responsible: draft.responsible,
        ...(logoUrl === '' ? {} : { logoUrl }),
      };
    }
    if (step === 4) {
      const environment = textOf(draft.environment).trim();
      return {
        mode: draft.mode,
        ...(draft.mode === 'sunat_beta' || environment !== '' ? { environment } : {}),
      };
    }
    if (step === 6) return undefined;
    if (step === 7) return { confirmed: draft.confirmed === true };
    return { ...draft };
  }

  async function confirmStep(): Promise<void> {
    setSubmitting(true);
    setSubmitFailure(null);
    try {
      const response = await submitOnboardingStep(currentStep, payloadFor(currentStep));
      const confirmed = { ...snapshots, [currentStep]: snapshots[currentStep] ?? payloadFor(currentStep) };
      setSnapshots(confirmed);
      if (response.acta !== null) {
        setActa(response.acta);
        setFinished(true);
      } else if (response.nextStep !== null) {
        openStep(response.nextStep, confirmed);
      }
    } catch (error) {
      setSubmitFailure(failureOf(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === 'loading') {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">Cargando el estado del alta…</p>
        </CardContent>
      </Card>
    );
  }

  if (loadFailure !== null) {
    return (
      <Alert variant="info" title="El alta no se pudo leer">
        <p>{loadFailure.message}</p>
        <p className="mt-1">Vuelva a cargar la página para intentarlo de nuevo.</p>
        <p className="mt-1">Si el problema sigue, avise a soporte.</p>
        <CopyDetail failure={loadFailure} />
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reintentar
          </Button>
        </div>
      </Alert>
    );
  }

  if (finished) {
    return (
      <Card tone="tinted">
        <CardHeader>
          <CardEyebrow>Alta cerrada</CardEyebrow>
          <CardTitle as="h2">Acta firmada</CardTitle>
          <CardDescription>
            El alta quedó cerrada e inmutable. Las rutas de negocio dejan de responder pendiente.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {acta === null ? (
            <p className="text-sm text-muted-foreground">
              El acta ya existía: vuelva a abrirla con <code className="font-mono text-xs">GET /v1/onboarding/acta</code>.
            </p>
          ) : (
            <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">sha256</dt>
              <dd className="font-mono break-all">{acta.hash}</dd>
              <dt className="text-muted-foreground">idempotency</dt>
              <dd className="font-mono break-all">{acta.payload.idempotencyKey}</dd>
            </dl>
          )}
        </CardContent>
      </Card>
    );
  }

  const meta = WIZARD_STEPS[currentStep - 1];

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-wrap gap-2" aria-label="Pasos del alta">
        {WIZARD_STEPS.map((entry) => {
          const done = snapshots[entry.step] !== undefined;
          const active = entry.step === currentStep;
          return (
            <li key={entry.step}>
              <Badge variant={active ? 'tinted' : 'outline'}>
                {entry.step} · {entry.title}
              </Badge>
            </li>
          );
        })}
      </ol>

      <Card tone="accent">
        <CardHeader>
          <CardEyebrow>
            Paso {currentStep} de {WIZARD_STEPS.length}
          </CardEyebrow>
          <CardTitle as="h2">{meta?.title ?? `Paso ${currentStep}`}</CardTitle>
          <CardDescription>{meta?.description ?? ''}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {currentStep === 1 ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Field label="Razón social" htmlFor="organizer-legalName" />
                <Input
                  id="organizer-legalName"
                  value={textOf(draft.legalName)}
                  onChange={(event) => setField('legalName', event.target.value)}
                  placeholder="Clínica Demo Norte S.A.C."
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Field label="RUC" hint="11 dígitos con dígito verificador SUNAT." htmlFor="organizer-ruc" />
                <Input
                  id="organizer-ruc"
                  value={textOf(draft.ruc)}
                  onChange={(event) => setField('ruc', event.target.value)}
                  placeholder={DEMO_RUC_PLACEHOLDER}
                  inputMode="numeric"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Field label="Domicilio fiscal" htmlFor="organizer-address" />
                <Input
                  id="organizer-address"
                  value={textOf(draft.fiscalAddress)}
                  onChange={(event) => setField('fiscalAddress', event.target.value)}
                  placeholder="Av. Demo 123, Lima"
                  autoComplete="off"
                />
              </div>
            </>
          ) : null}

          {currentStep === 2 ? (
            <div className="flex flex-col gap-4">
              {sites.map((site, index) => (
                <fieldset key={index} className="flex flex-col gap-2 rounded-md border border-border p-3">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">
                    Sede {index + 1}
                  </legend>
                  <div className="flex flex-col gap-1.5">
                    <Field label="Nombre" htmlFor={`site-name-${index}`} />
                    <Input
                      id={`site-name-${index}`}
                      value={site.name}
                      onChange={(event) =>
                        setSites((previous) =>
                          previous.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, name: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="Sede Demo Norte"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Field label="Dirección" htmlFor={`site-address-${index}`} />
                    <Input
                      id={`site-address-${index}`}
                      value={site.address}
                      onChange={(event) =>
                        setSites((previous) =>
                          previous.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, address: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="Av. Demo 123, Lima"
                      autoComplete="off"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Field label="Casilla ARCO" htmlFor={`site-arco-${index}`} />
                    <Input
                      id={`site-arco-${index}`}
                      value={site.arcoEmail}
                      onChange={(event) =>
                        setSites((previous) =>
                          previous.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, arcoEmail: event.target.value } : row,
                          ),
                        )
                      }
                      placeholder="arco.norte@example.invalid"
                      inputMode="email"
                      autoComplete="off"
                    />
                  </div>
                  {sites.length > 1 ? (
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setSites((previous) => previous.filter((_, rowIndex) => rowIndex !== index))
                        }
                      >
                        Quitar sede
                      </Button>
                    </div>
                  ) : null}
                </fieldset>
              ))}
              <div>
                <Button variant="outline" size="sm" onClick={() => setSites((previous) => [...previous, { ...EMPTY_SITE }])}>
                  Agregar sede
                </Button>
              </div>
            </div>
          ) : null}

          {currentStep === 3 ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Field label="Nombre visible" htmlFor="identity-visible" />
                <Input
                  id="identity-visible"
                  value={textOf(draft.visibleName)}
                  onChange={(event) => setField('visibleName', event.target.value)}
                  placeholder="Demo Salud"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Field label="Responsable de protección de datos" htmlFor="identity-responsible" />
                <Input
                  id="identity-responsible"
                  value={textOf(draft.responsible)}
                  onChange={(event) => setField('responsible', event.target.value)}
                  placeholder="Dra. Demo Responsable"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Field label="Logo (opcional)" htmlFor="identity-logo" />
                <Input
                  id="identity-logo"
                  value={textOf(draft.logoUrl)}
                  onChange={(event) => setField('logoUrl', event.target.value)}
                  placeholder="https://…/logo.png"
                  inputMode="url"
                  autoComplete="off"
                />
              </div>
            </>
          ) : null}

          {currentStep === 4 ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Field label="Modo de facturación" htmlFor="billing-mode" />
                <Select
                  id="billing-mode"
                  value={textOf(draft.mode) === '' ? 'manual' : textOf(draft.mode)}
                  onChange={(event) => setField('mode', event.target.value)}
                >
                  <option value="manual">manual</option>
                  <option value="sunat_beta">sunat_beta</option>
                </Select>
              </div>
              {textOf(draft.mode) === 'sunat_beta' ? (
                <div className="flex flex-col gap-1.5">
                  <Field label="Entorno" hint="Obligatorio en modo beta." htmlFor="billing-env" />
                  <Input
                    id="billing-env"
                    value={textOf(draft.environment)}
                    onChange={(event) => setField('environment', event.target.value)}
                    placeholder="beta"
                    autoComplete="off"
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {currentStep === 5 ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Field label="Usuario" htmlFor="admin-username" />
                <Input
                  id="admin-username"
                  value={textOf(draft.username)}
                  onChange={(event) => setField('username', event.target.value)}
                  placeholder="admin.demo"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Field label="Correo" htmlFor="admin-email" />
                <Input
                  id="admin-email"
                  value={textOf(draft.email)}
                  onChange={(event) => setField('email', event.target.value)}
                  placeholder="admin.demo@example.invalid"
                  inputMode="email"
                  autoComplete="off"
                />
              </div>
              <label className="flex items-center gap-2 text-sm" htmlFor="admin-mfa">
                <input
                  id="admin-mfa"
                  type="checkbox"
                  checked={draft.mfaEnrolled === true}
                  onChange={(event) => setField('mfaEnrolled', event.target.checked)}
                  className="h-4 w-4"
                />
                MFA ya enrolado (obligatorio)
              </label>
            </>
          ) : null}

          {currentStep === 6 ? (
            <dl className="tabular grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Organización</dt>
              <dd className="break-all">{textOf(asRecord(snapshots[1]).legalName) || '—'}</dd>
              <dt className="text-muted-foreground">RUC</dt>
              <dd className="font-mono break-all">{textOf(asRecord(snapshots[1]).ruc) || '—'}</dd>
              <dt className="text-muted-foreground">Sedes</dt>
              <dd className="break-all">
                {Array.isArray(asRecord(snapshots[2]).sites)
                  ? (asRecord(snapshots[2]).sites as SiteDraft[]).map((site) => site.name || '—').join(', ')
                  : '—'}
              </dd>
              <dt className="text-muted-foreground">Identidad</dt>
              <dd className="break-all">{textOf(asRecord(snapshots[3]).visibleName) || '—'}</dd>
              <dt className="text-muted-foreground">Facturación</dt>
              <dd className="font-mono break-all">{textOf(asRecord(snapshots[4]).mode) || '—'}</dd>
              <dt className="text-muted-foreground">Administración</dt>
              <dd className="break-all">{textOf(asRecord(snapshots[5]).username) || '—'}</dd>
            </dl>
          ) : null}

          {currentStep === 7 ? (
            <label className="flex items-center gap-2 text-sm" htmlFor="confirm-acta">
              <input
                id="confirm-acta"
                type="checkbox"
                checked={draft.confirmed === true}
                onChange={(event) => setField('confirmed', event.target.checked)}
                className="h-4 w-4"
              />
              Confirmo el acta: el alta queda cerrada e inmutable.
            </label>
          ) : null}

          {submitFailure !== null ? (
            <Alert variant={submitFailure.code === 'access.denied' ? 'denied' : 'info'} title="El paso no se aplicó">
              <p>{submitFailure.message}</p>
              <p className="mt-1">Revise el paso e intente de nuevo.</p>
              <p className="mt-1">Si el problema sigue, avise a jefatura o a soporte.</p>
              <CopyDetail failure={submitFailure} />
            </Alert>
          ) : null}

          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void confirmStep()} disabled={submitting}>
              {submitting ? 'Confirmando…' : currentStep === 7 ? 'Firmar acta' : currentStep === 6 ? 'Continuar' : 'Confirmar paso'}
            </Button>
            {currentStep > 1 && snapshots[currentStep - 1] !== undefined ? (
              <Button variant="ghost" onClick={() => openStep(currentStep - 1, snapshots)} disabled={submitting}>
                Volver
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
