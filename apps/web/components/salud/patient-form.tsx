'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import {
  DOCUMENT_TYPES,
  PATIENT_NAME_MAX,
  checkDateField,
  checkDocumentNumberField,
  checkDocumentTypeField,
  checkOptionalText,
  checkRequiredText,
  checkUuidField,
  firstIssue,
  type DocumentType,
  type FieldCheck,
  type PatientCreateInput,
  type PatientRecord,
} from '@rizoma/contracts';
import { requestJson } from '@/lib/api-client';
import { CharCounter, FieldMessage, SavedPulse, fieldStateProps } from '@/components/ui/field-feedback';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { MagneticCta } from '@/components/ui/magnetic';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FailurePanel } from '@/components/salud/states';
import { createPatient } from '@/lib/salud-api';
import { listOrgNodes } from '@/lib/org-api';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { DOCUMENT_TYPE_LABELS, documentTypeLabel, roleLabel } from '@/lib/labels';
import { cn } from '@/lib/utils';

/**
 * Patient registration form with validation that runs while the user types.
 *
 * The interesting decisions, in order:
 *   - the checks are the `@rizoma/contracts` field validators, i.e. the same
 *     rules the API service applies on arrival; nothing here re-invents a rule,
 *     so the form can never be more permissive than the endpoint;
 *   - a verdict is shown per field, and only after the field was touched (blur or
 *     a submit attempt), so the form does not shout while someone fills it in;
 *   - the success state is part of the interface, not an assumption: the panel
 *     says the file was registered and, when the role cannot open the ficha, it
 *     says that too instead of offering a link that would 403;
 *   - the `orgNodeId` is picked from the sede list with a browser-side search.
 *     The id travels as the option value and only the sede name is visible.
 */
export interface PatientFormProps {
  /** Sede the file will be registered under; prefilled, still editable. */
  readonly defaultOrgNodeId: string;
  /** Role driving the copy that explains what happens after a registration. */
  readonly role: string | null;
  /**
   * Whether the current role may open the registered file afterwards
   * (`patient.read`). Reception registers files and does not read them, so the
   * form has to be honest about the follow-up.
   */
  readonly canOpenFile: boolean;
  /** Called once per successful registration, with the created row. */
  readonly onCreated: (patient: PatientRecord) => void;
  readonly className?: string;
}

interface Draft {
  personName: string;
  documentType: DocumentType;
  documentNumber: string;
  birthdate: string;
  allergies: string;
  alerts: string;
  phone: string;
  orgNodeId: string;
}

function initialDraft(orgNodeId: string): Draft {
  return {
    personName: '',
    documentType: 'dni',
    documentNumber: '',
    birthdate: '',
    allergies: '',
    alerts: '',
    phone: '',
    orgNodeId,
  };
}

/**
 * Typed custom key of `patient_files.contacts` (B2). Local schema until
 * `packages/contracts/src/index.ts` re-exports `./custom-fields.ts` — it
 * mirrors `customFieldDefSchema` field by field, so the section below renders
 * exactly the `active` definitions the API would enforce on arrival.
 */
const customFieldDefSchema = z.object({
  id: z.string(),
  module: z.string(),
  entity: z.string(),
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  type: z.enum(['text', 'number', 'date', 'boolean']),
  required: z.boolean(),
  status: z.string(),
});
type CustomFieldDef = z.infer<typeof customFieldDefSchema>;

/** Free-text custom value cap; the API stores the bag as JSONB, not a column. */
const CUSTOM_TEXT_MAX = 500;

/** Live check of one custom value, mirroring `validateCustomValues` server-side. */
function checkCustomField(def: CustomFieldDef, raw: string): FieldCheck {
  const field = `custom.${def.code}`;
  const value = (raw ?? '').trim();
  if (value === '') return def.required ? { field, code: 'required' } : null;
  switch (def.type) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : { field, code: 'invalid_number' };
    case 'date':
      return checkDateField(field, value);
    case 'boolean':
      return null;
    case 'text':
      return def.required
        ? checkRequiredText(field, value, CUSTOM_TEXT_MAX)
        : checkOptionalText(field, value, CUSTOM_TEXT_MAX);
  }
}

/** Parses the string-held custom values into the JSONB bag the API types. */
function parseCustomValues(
  defs: readonly CustomFieldDef[],
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = (values[def.code] ?? '').trim();
    if (raw === '') continue;
    if (def.type === 'number') bag[def.code] = Number(raw);
    else if (def.type === 'boolean') bag[def.code] = raw === 'true';
    else bag[def.code] = raw;
  }
  return bag;
}

/** Splits a comma-separated free-text list into the array the API stores. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function PatientForm({
  defaultOrgNodeId,
  role,
  canOpenFile,
  onCreated,
  className,
}: PatientFormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(defaultOrgNodeId));
  const [touched, setTouched] = useState<Readonly<Record<string, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [created, setCreated] = useState<PatientRecord | null>(null);
  // B2 custom keys of `contacts`: `active` definitions of (salud, patient).
  // A failed read degrades to no section — the API still enforces on arrival.
  const [customDefs, setCustomDefs] = useState<readonly CustomFieldDef[]>([]);
  const [customValues, setCustomValues] = useState<Readonly<Record<string, string>>>({});
  const [sedeItems, setSedeItems] = useState<readonly EntityItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    listOrgNodes({ kind: 'sede' }, controller.signal)
      .then((rows) => {
        if (!active) return;
        setSedeItems(rows.map((row) => ({ id: row.id, label: row.name })));
      })
      .catch(() => {
        if (active) setSedeItems([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    requestJson(
      '/custom-fields?module=salud&entity=patient&status=active',
      z.array(customFieldDefSchema),
      { signal: controller.signal },
    )
      .then((rows) => {
        if (!active) return;
        setCustomDefs((rows ?? []).filter((def) => def.status === 'active'));
      })
      .catch(() => {
        if (active) setCustomDefs([]);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  // Recomputed on every render: these checks are pure and cheap, which is what
  // makes "validate while typing" a plain derived value instead of an effect.
  const checks: Readonly<Record<string, FieldCheck>> = useMemo(
    () => ({
      personName: checkRequiredText('personName', draft.personName, PATIENT_NAME_MAX),
      documentType: checkDocumentTypeField('documentType', draft.documentType),
      documentNumber: checkDocumentNumberField(
        'documentNumber',
        draft.documentType,
        draft.documentNumber,
      ),
      birthdate: checkDateField('birthdate', draft.birthdate),
      orgNodeId: checkUuidField('orgNodeId', draft.orgNodeId),
      ...Object.fromEntries(
        customDefs.map((def) => [
          `custom.${def.code}`,
          checkCustomField(def, customValues[def.code] ?? ''),
        ]),
      ),
    }),
    [draft, customDefs, customValues],
  );

  const blocking = submitted ? firstIssue(checks) : null;
  const show = (field: string): boolean => touched[field] === true || submitted;

  function set<K extends keyof Draft>(field: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function touch(field: string): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setFailure(null);
    if (firstIssue(checks) !== null) return;

    setSaving(true);
    try {
      const input: PatientCreateInput = {
        orgNodeId: draft.orgNodeId.trim(),
        personName: draft.personName.trim(),
        documentType: draft.documentType,
        documentNumber: draft.documentNumber.trim(),
        birthdate: draft.birthdate.trim() === '' ? null : draft.birthdate.trim(),
        allergies: splitList(draft.allergies),
        alerts: splitList(draft.alerts),
        contacts: {
          ...(draft.phone.trim() === '' ? {} : { phone: draft.phone.trim() }),
          ...parseCustomValues(customDefs, customValues),
        },
      };
      const patient = await createPatient(input);
      setCreated(patient);
      onCreated(patient);
      // The sede is kept: registering several files for the same sede is the
      // normal case at a front desk.
      setDraft(initialDraft(patient.orgNodeId));
      setCustomValues({});
      setTouched({});
      setSubmitted(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className} id="registrar-paciente">
      <CardHeader>
        <CardEyebrow>Registro</CardEyebrow>
        <CardTitle as="h2">Registrar una ficha de paciente</CardTitle>
        <CardDescription>
          La validación se ejecuta mientras escribe y replica el contrato del API: catálogo de
          documento, DNI de 8 dígitos, fecha real en formato AAAA-MM-DD y la sede elegida de la
          lista. El
          envío se firma con un <code className="font-mono text-xs">Idempotency-Key</code> propio de
          cada intención.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
          <LiveField
            id="patient-person-name"
            label="Nombre completo"
            counter={<CharCounter value={draft.personName} max={PATIENT_NAME_MAX} />}
            issue={checks.personName ?? null}
            touched={show('personName')}
          >
            <Input
              id="patient-person-name"
              name="personName"
              autoComplete="off"
              value={draft.personName}
              maxLength={PATIENT_NAME_MAX}
              onChange={(event) => set('personName', event.target.value)}
              onBlur={() => touch('personName')}
              {...fieldStateProps(checks.personName ?? null, show('personName'))}
            />
          </LiveField>

          <div className="grid gap-5 sm:grid-cols-2">
            <LiveField
              id="patient-document-type"
              label="Tipo de documento"
              issue={checks.documentType ?? null}
              touched={show('documentType')}
            >
              <Select
                id="patient-document-type"
                name="documentType"
                value={draft.documentType}
                onChange={(event) => set('documentType', event.target.value as DocumentType)}
                onBlur={() => touch('documentType')}
              >
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {DOCUMENT_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </LiveField>

            <LiveField
              id="patient-document-number"
              label="Número de documento"
              hint={draft.documentType === 'dni' ? 'Ocho dígitos, sin espacios.' : undefined}
              issue={checks.documentNumber ?? null}
              touched={show('documentNumber')}
            >
              <Input
                id="patient-document-number"
                name="documentNumber"
                inputMode={draft.documentType === 'dni' ? 'numeric' : 'text'}
                autoComplete="off"
                value={draft.documentNumber}
                onChange={(event) => set('documentNumber', event.target.value)}
                onBlur={() => touch('documentNumber')}
                {...fieldStateProps(checks.documentNumber ?? null, show('documentNumber'))}
              />
            </LiveField>

            <LiveField
              id="patient-birthdate"
              label="Fecha de nacimiento"
              hint="Opcional. Se guarda como fecha (AAAA-MM-DD)."
              issue={checks.birthdate ?? null}
              touched={show('birthdate')}
            >
              <Input
                id="patient-birthdate"
                name="birthdate"
                placeholder="1990-01-31"
                autoComplete="off"
                value={draft.birthdate}
                onChange={(event) => set('birthdate', event.target.value)}
                onBlur={() => touch('birthdate')}
                {...fieldStateProps(checks.birthdate ?? null, show('birthdate'))}
              />
            </LiveField>

            <LiveField
              id="patient-phone"
              label="Teléfono de contacto"
              hint="Opcional. Se guarda dentro de contacts."
              issue={null}
              touched={false}
            >
              <Input
                id="patient-phone"
                name="phone"
                inputMode="tel"
                autoComplete="off"
                value={draft.phone}
                onChange={(event) => set('phone', event.target.value)}
              />
            </LiveField>

            <LiveField
              id="patient-allergies"
              label="Alergias"
              hint="Separadas por coma. Se muestran antes de cualquier acción clínica."
              issue={null}
              touched={false}
            >
              <Input
                id="patient-allergies"
                name="allergies"
                autoComplete="off"
                value={draft.allergies}
                onChange={(event) => set('allergies', event.target.value)}
              />
            </LiveField>

            <LiveField
              id="patient-alerts"
              label="Alertas"
              hint="Separadas por coma."
              issue={null}
              touched={false}
            >
              <Input
                id="patient-alerts"
                name="alerts"
                autoComplete="off"
                value={draft.alerts}
                onChange={(event) => set('alerts', event.target.value)}
              />
            </LiveField>

            {customDefs.length === 0 ? null : (
              <fieldset className="flex flex-col gap-4 rounded-md border border-border bg-secondary p-4 sm:col-span-2">
                <legend className="px-1 text-[0.8125rem] font-medium">
                  Campos personalizados
                </legend>
                <p className="text-xs text-muted-foreground">
                  Claves tipadas del tenant para esta ficha. Viajan dentro de{' '}
                  <code className="font-mono">contacts</code> y el API las valida por tipo.
                </p>
                {customDefs.map((def) => {
                  const field = `custom.${def.code}`;
                  const raw = customValues[def.code] ?? '';
                  return (
                    <LiveField
                      key={def.code}
                      id={`patient-custom-${def.code}`}
                      label={`${def.code}${def.required ? ' *' : ''}`}
                      hint={
                        def.type === 'date'
                          ? 'Fecha real en formato AAAA-MM-DD.'
                          : def.type === 'boolean'
                            ? 'Marcado es verdadero, sin marcar es falso.'
                            : undefined
                      }
                      issue={checks[field] ?? null}
                      touched={show(field)}
                    >
                      {def.type === 'boolean' ? (
                        <input
                          id={`patient-custom-${def.code}`}
                          name={field}
                          type="checkbox"
                          className="h-4 w-4"
                          checked={raw === 'true'}
                          onChange={(event) =>
                            setCustomValues((current) => ({
                              ...current,
                              [def.code]: event.target.checked ? 'true' : 'false',
                            }))
                          }
                          onBlur={() => touch(field)}
                        />
                      ) : (
                        <Input
                          id={`patient-custom-${def.code}`}
                          name={field}
                          autoComplete="off"
                          inputMode={def.type === 'number' ? 'decimal' : undefined}
                          placeholder={def.type === 'date' ? 'AAAA-MM-DD' : undefined}
                          value={raw}
                          onChange={(event) =>
                            setCustomValues((current) => ({
                              ...current,
                              [def.code]: event.target.value,
                            }))
                          }
                          onBlur={() => touch(field)}
                          {...fieldStateProps(checks[field] ?? null, show(field))}
                        />
                      )}
                    </LiveField>
                  );
                })}
              </fieldset>
            )}

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <EntitySelector
                label="Sede"
                items={sedeItems}
                value={draft.orgNodeId === '' ? null : draft.orgNodeId}
                onChange={(id) => {
                  set('orgNodeId', id ?? '');
                  touch('orgNodeId');
                }}
                placeholder="Seleccionar sede…"
                searchPlaceholder="Buscar por nombre…"
              />
              <FieldMessage issue={checks.orgNodeId ?? null} touched={show('orgNodeId')} validLabel="Dato aceptado." />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <MagneticCta type="submit" disabled={saving}>
              {saving ? 'Registrando…' : 'Registrar paciente'}
            </MagneticCta>
            {created === null ? null : (
              <SavedPulse label="Ficha registrada" resetKey={created.id} />
            )}
            {blocking === null ? null : (
              <p className="text-xs text-danger">
                Revise los campos señalados: la solicitud no se envió.
              </p>
            )}
          </div>
        </form>

        {failure === null ? null : (
          <FailurePanel className="mt-4" title="La ficha no se registró" failure={failure} />
        )}

        {created === null ? null : (
          <div className="sd-rise mt-4 flex flex-col gap-1 rounded-md border border-border bg-secondary px-4 py-3">
            <p className="text-[0.8125rem]">
              Registrado: <span className="font-medium">{created.personName}</span> ·{' '}
              <span className="tabular font-mono text-xs">
                {documentTypeLabel(created.documentType)} {created.documentNumber}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {canOpenFile
                ? 'La ficha ya se puede abrir desde la lista para completar consentimientos y episodios.'
                : `El rol ${roleLabel(role)} registra fichas pero no puede abrirlas después: el enlace no se ofrece y la ficha queda visible para los roles con permiso. Si necesita este acceso, avise a jefatura o a soporte.`}
            </p>
            {canOpenFile ? null : (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground underline underline-offset-2">
                  Copiar detalle
                </summary>
                <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
                  {`code: access.denied\nreason: role.denied\nstatus: 403\naction: patient.read`}
                </pre>
              </details>
            )}
            <p className="tabular font-mono text-[0.6875rem] text-muted-foreground">
              id {created.id}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface LiveFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly counter?: ReactNode;
  readonly issue: FieldCheck;
  readonly touched: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Label + counter + control + verdict, so a form row is one block. */
function LiveField({
  id,
  label,
  hint,
  counter,
  issue,
  touched,
  className,
  children,
}: LiveFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[0.8125rem] font-medium text-foreground">
          {label}
        </label>
        {counter}
      </div>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldMessage issue={issue} touched={touched} validLabel="Dato aceptado." />
    </div>
  );
}
