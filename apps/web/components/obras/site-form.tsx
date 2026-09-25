'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  SITE_CLIENT_NAME_MAX,
  SITE_CODE_MAX,
  SITE_NAME_MAX,
  SITE_STATUSES,
  checkOptionalAmountField,
  checkRequiredText,
  checkUuidField,
  firstIssue,
  type FieldCheck,
  type SiteCreateInput,
  type SiteRecord,
  type SiteStatus,
} from '@rizoma/contracts';
import { CharCounter, FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { MagneticCta } from '@/components/ui/magnetic';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { WriteResult } from '@/components/ui/states';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createSite } from '@/lib/obras-api';
import { SITE_STATUS_LABELS } from '@/lib/labels';

/**
 * Site registration form (`site.write`, gerente only).
 *
 * The checks are the `@rizoma/contracts` field validators, i.e. the same rules
 * the API service applies on arrival: a non-empty code, name and client, a UUID
 * sede and an optional non-negative budget. `budgetTotal` and `status` are
 * *optional* on purpose — the service defaults them to `0` and `planned`, so the
 * form refuses nothing the endpoint would accept.
 *
 * This is the one magnetic CTA of `/obras`: the design steer allows exactly one
 * pull-to-pointer control per screen, and it is the one that submits the
 * screen's intent.
 */
export interface SiteFormProps {
  /** Sede the obra will be created under; prefilled, still editable. */
  readonly defaultOrgNodeId: string;
  /** Called once per successful creation, with the created row. */
  readonly onCreated: (site: SiteRecord) => void;
  readonly className?: string;
}

interface Draft {
  orgNodeId: string;
  code: string;
  name: string;
  clientName: string;
  budgetTotal: string;
  status: SiteStatus;
}

function initialDraft(orgNodeId: string): Draft {
  return {
    orgNodeId,
    code: '',
    name: '',
    clientName: '',
    budgetTotal: '',
    status: 'planned',
  };
}

export function SiteForm({ defaultOrgNodeId, onCreated, className }: SiteFormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(defaultOrgNodeId));
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const checks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      orgNodeId: checkUuidField('orgNodeId', draft.orgNodeId),
      code: checkRequiredText('code', draft.code, SITE_CODE_MAX),
      name: checkRequiredText('name', draft.name, SITE_NAME_MAX),
      clientName: checkRequiredText('clientName', draft.clientName, SITE_CLIENT_NAME_MAX),
      budgetTotal: checkOptionalAmountField('budgetTotal', draft.budgetTotal),
    }),
    [draft],
  );

  const blocking = submitted ? firstIssue(checks) : null;
  const show = (field: string): boolean => touched[field] === true || submitted;

  function set<K extends keyof Draft>(field: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setSuccess(null);
  }

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setFailure(null);
    setSuccess(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const budget = draft.budgetTotal.trim();
      const input: SiteCreateInput = {
        orgNodeId: draft.orgNodeId.trim(),
        code: draft.code.trim(),
        name: draft.name.trim(),
        clientName: draft.clientName.trim(),
        budgetTotal: budget === '' ? 0 : Number(budget),
        status: draft.status,
      };
      const site = await createSite(input);
      onCreated(site);
      setSuccess(`Obra ${site.code} registrada en estado ${SITE_STATUS_LABELS[site.status as SiteStatus] ?? site.status}.`);
      // The sede is kept: creating several obras for the same node is the normal
      // case for gerencia.
      setDraft(initialDraft(site.orgNodeId));
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} id="registrar-obra">
      <CardHeader>
        <CardEyebrow>Registro</CardEyebrow>
        <CardTitle as="h2">Registrar una obra</CardTitle>
        <CardDescription>
          El alta exige <code className="font-mono text-xs">site.write</code>, que en la matriz solo
          tiene gerencia. El presupuesto es opcional y el estado por defecto es «Planificada»: los
          mismos valores que aplica el servicio cuando el campo no llega. El envío se firma con un{' '}
          <code className="font-mono text-xs">Idempotency-Key</code> propio de cada intención.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
          <LiveField
            id="site-org-node"
            label="Sede (nodo de organización)"
            hint="UUID del nodo. El API comprueba que esté dentro del subárbol de su membresía."
            issue={checks.orgNodeId ?? null}
            touched={show('orgNodeId')}
          >
            <Input
              id="site-org-node"
              name="orgNodeId"
              className="font-mono text-xs"
              spellCheck={false}
              value={draft.orgNodeId}
              onChange={(event) => set('orgNodeId', event.target.value)}
              onBlur={() => touch('orgNodeId')}
              {...fieldStateProps(checks.orgNodeId ?? null, show('orgNodeId'))}
            />
          </LiveField>

          <div className="grid gap-5 sm:grid-cols-2">
            <LiveField
              id="site-code"
              label="Código de obra"
              counter={<CharCounter value={draft.code} max={SITE_CODE_MAX} />}
              issue={checks.code ?? null}
              touched={show('code')}
            >
              <Input
                id="site-code"
                name="code"
                autoComplete="off"
                value={draft.code}
                maxLength={SITE_CODE_MAX}
                onChange={(event) => set('code', event.target.value)}
                onBlur={() => touch('code')}
                {...fieldStateProps(checks.code ?? null, show('code'))}
              />
            </LiveField>

            <LiveField id="site-name" label="Nombre de la obra" issue={checks.name ?? null} touched={show('name')}>
              <Input
                id="site-name"
                name="name"
                autoComplete="off"
                value={draft.name}
                maxLength={SITE_NAME_MAX}
                onChange={(event) => set('name', event.target.value)}
                onBlur={() => touch('name')}
                {...fieldStateProps(checks.name ?? null, show('name'))}
              />
            </LiveField>

            <LiveField
              id="site-client"
              label="Cliente"
              issue={checks.clientName ?? null}
              touched={show('clientName')}
            >
              <Input
                id="site-client"
                name="clientName"
                autoComplete="off"
                value={draft.clientName}
                maxLength={SITE_CLIENT_NAME_MAX}
                onChange={(event) => set('clientName', event.target.value)}
                onBlur={() => touch('clientName')}
                {...fieldStateProps(checks.clientName ?? null, show('clientName'))}
              />
            </LiveField>

            <LiveField
              id="site-budget"
              label="Presupuesto total"
              hint="Opcional. Se registra como 0 cuando queda vacío."
              issue={checks.budgetTotal ?? null}
              touched={show('budgetTotal')}
            >
              <Input
                id="site-budget"
                name="budgetTotal"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={draft.budgetTotal}
                onChange={(event) => set('budgetTotal', event.target.value)}
                onBlur={() => touch('budgetTotal')}
                {...fieldStateProps(checks.budgetTotal ?? null, show('budgetTotal'))}
              />
            </LiveField>

            <LiveField id="site-status" label="Estado inicial" issue={null} touched={false}>
              <Select
                id="site-status"
                name="status"
                value={draft.status}
                onChange={(event) => set('status', event.target.value as SiteStatus)}
              >
                {SITE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {SITE_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </LiveField>
          </div>

          {blocking === null ? null : (
            <p className="text-xs text-danger">
              Revise el campo señalado antes de enviar: el API rechazaría el mismo valor con{' '}
              <code className="font-mono">validation.failed</code>.
            </p>
          )}

          <div className="flex items-center gap-3">
            <MagneticCta type="submit" disabled={saving}>
              {saving ? 'Registrando…' : 'Registrar obra'}
            </MagneticCta>
          </div>

          <WriteResult failure={failure} success={success} />
        </form>
      </CardContent>
    </Card>
  );
}

/** Field wrapper with a live verdict, mirroring the salud forms. */
function LiveField({
  id,
  label,
  hint,
  counter,
  issue,
  touched,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly counter?: ReactNode;
  readonly issue: FieldCheck;
  readonly touched: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
          {label}
        </label>
        {counter}
      </div>
      {children}
      <FieldMessage issue={issue} touched={touched} />
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
