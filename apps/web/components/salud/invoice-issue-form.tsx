'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  BILLING_DESCRIPTION_MAX,
  BILLING_DOCUMENT_TYPES,
  DEFAULT_IGV_RATE,
  checkIgvRateField,
  checkInvoiceDocumentNumberField,
  checkOptionalUuidField,
  checkRequiredText,
  checkUuidField,
  checkSerieField,
  firstIssue,
  type BillingDocumentType,
  type FieldCheck,
  type InvoiceRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, SavedPulse, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { MagneticCta } from '@/components/ui/magnetic';
import { Select } from '@/components/ui/select';
import {
  BillingLinesField,
  firstLineIssue,
  lineChecks,
  newBillingLineDraft,
  toBillingLines,
  type BillingLineDraft,
} from '@/components/salud/billing-lines-field';
import { FailurePanel } from '@/components/salud/states';
import { billingDocumentTypeLabel, fiscalStatusLabel, fiscalStatusVariant } from '@/lib/labels';
import { formatPen, shortId } from '@/lib/format';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { issueInvoice } from '@/lib/salud-api';
import { cn } from '@/lib/utils';

/** What a quote hands to the issue form: identifiers and the priced lines. */
export interface InvoiceDraftSeed {
  readonly quoteId: string;
  readonly customerName: string;
  readonly items: readonly BillingLineDraft[];
}

/**
 * Issue form of a manual invoice (`POST /billing/invoices/issue`).
 *
 * The three properties that make it honest about what the API does:
 *
 *   - **The folio is not ours.** The client sends a `serie` and nothing else:
 *     the service reserves the next `numero` under `SELECT ... FOR UPDATE`, which
 *     is what makes the folio gapless per tenant+serie. There is no "number"
 *     field to fill, because filling it would be a lie about who owns it.
 *   - **The IGV is not ours either.** `igvRate` is parametrizable (default
 *     0.18), and the per-line rounding lives in `computeInvoiceTotals`. The form
 *     sends the rate and the lines; it never sends a subtotal or a total.
 *   - **The replay key is per intent.** `issueInvoice` mints a fresh
 *     `Idempotency-Key` inside the call, so a double click collapses into one
 *     invoice instead of two, and a retry after a timeout replays the original
 *     document instead of emitting a second one.
 */
export interface InvoiceIssueFormProps {
  /** Quote to prefill from, or `null` for a manual document. */
  readonly seed: InvoiceDraftSeed | null;
  /** Sede prefill, from the last real row the screen read. */
  readonly defaultOrgNodeId: string;
  /** Shift of this session, when there is one, to bind the document to it. */
  readonly cashSessionId: string | null;
  readonly onIssued: (invoice: InvoiceRecord) => void;
  readonly className?: string;
}

interface Draft {
  orgNodeId: string;
  serie: string;
  customerDocType: BillingDocumentType;
  customerDocNumber: string;
  customerName: string;
  igvRate: string;
  cashSessionId: string;
}

function initialDraft(orgNodeId: string, cashSessionId: string | null): Draft {
  return {
    orgNodeId,
    serie: 'F001',
    customerDocType: 'dni',
    customerDocNumber: '',
    customerName: '',
    igvRate: String(DEFAULT_IGV_RATE),
    cashSessionId: cashSessionId ?? '',
  };
}

export function InvoiceIssueForm({
  seed,
  defaultOrgNodeId,
  cashSessionId,
  onIssued,
  className,
}: InvoiceIssueFormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(defaultOrgNodeId, cashSessionId));
  const [lines, setLines] = useState<readonly BillingLineDraft[]>(() => [newBillingLineDraft()]);
  const [quoteId, setQuoteId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [issued, setIssued] = useState<InvoiceRecord | null>(null);

  // A quote handoff rewrites the draft: the lines are the quote's, and the
  // identifier travels as `quoteId` so the invoice stays traceable to it.
  useEffect(() => {
    if (seed === null) return;
    setDraft((current) => ({ ...current, customerName: seed.customerName }));
    setLines(seed.items.length === 0 ? [newBillingLineDraft()] : seed.items);
    setQuoteId(seed.quoteId);
    setTouched(false);
    setIssued(null);
  }, [seed]);

  // Keep the sede and the shift fresh without clobbering what the user typed.
  useEffect(() => {
    setDraft((current) => ({
      ...current,
      orgNodeId: current.orgNodeId === '' ? defaultOrgNodeId : current.orgNodeId,
      cashSessionId: current.cashSessionId === '' && cashSessionId !== null ? cashSessionId : current.cashSessionId,
    }));
  }, [defaultOrgNodeId, cashSessionId]);

  const checks: Readonly<Record<string, FieldCheck>> = {
    orgNodeId: checkUuidField('orgNodeId', draft.orgNodeId),
    serie: checkSerieField('serie', draft.serie),
    customerDocNumber: checkInvoiceDocumentNumberField(
      'customerDocNumber',
      draft.customerDocType,
      draft.customerDocNumber,
    ),
    customerName: checkRequiredText('customerName', draft.customerName, BILLING_DESCRIPTION_MAX),
    igvRate: checkIgvRateField('igvRate', draft.igvRate),
    cashSessionId: checkOptionalUuidField('cashSessionId', draft.cashSessionId),
    ...lineChecks(lines),
  };

  function set<K extends keyof Draft>(field: K, value: Draft[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    setIssued(null);
    if (firstIssue(checks) !== null || firstLineIssue(lines) !== null) return;

    setSaving(true);
    try {
      const invoice = await issueInvoice({
        orgNodeId: draft.orgNodeId.trim(),
        serie: draft.serie.trim().toUpperCase(),
        customerDocType: draft.customerDocType,
        customerDocNumber: draft.customerDocNumber.trim(),
        customerName: draft.customerName.trim(),
        igvRate: Number(draft.igvRate),
        items: toBillingLines(lines),
        ...(quoteId === null ? {} : { quoteId }),
        ...(draft.cashSessionId.trim() === '' ? {} : { cashSessionId: draft.cashSessionId.trim() }),
      });
      setIssued(invoice);
      onIssued(invoice);
      setDraft((current) => ({
        ...initialDraft(current.orgNodeId, invoice.cashSessionId),
        serie: current.serie,
        customerDocType: current.customerDocType,
      }));
      setLines([newBillingLineDraft()]);
      setQuoteId(null);
      setTouched(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={cn(className)} tone="accent">
      <CardHeader>
        <CardEyebrow>Emitir comprobante</CardEyebrow>
        <CardTitle as="h2">Factura manual</CardTitle>
        <CardDescription>
          El folio lo reserva el API: la serie es el único dato del número que se envía. El IGV se
          calcula por línea y se redondea a dos decimales en el servicio, así que aquí solo se
          declara la tasa y las líneas.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={handleSubmit} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-serie" className="text-[0.8125rem] font-medium">
                Serie
              </label>
              <Input
                id="invoice-serie"
                value={draft.serie}
                maxLength={8}
                disabled={saving}
                onChange={(event) => set('serie', event.target.value.toUpperCase())}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks.serie ?? null, touched)}
              />
              <p className="text-xs text-muted-foreground">
                Hasta 8 caracteres alfanuméricos. El número correlativo lo asigna el API sin huecos
                por tenant y serie.
              </p>
              <FieldMessage issue={checks.serie ?? null} touched={touched} validLabel="Serie aceptada." />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-doc-type" className="text-[0.8125rem] font-medium">
                Tipo de documento del cliente
              </label>
              <Select
                id="invoice-doc-type"
                value={draft.customerDocType}
                disabled={saving}
                onChange={(event) => set('customerDocType', event.target.value as BillingDocumentType)}
                onBlur={() => setTouched(true)}
              >
                {BILLING_DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {billingDocumentTypeLabel(type)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Un DNI lleva 8 dígitos y un RUC 11; carné y pasaporte quedan como texto libre.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-doc-number" className="text-[0.8125rem] font-medium">
                Número de documento
              </label>
              <Input
                id="invoice-doc-number"
                className="font-mono text-xs"
                spellCheck={false}
                value={draft.customerDocNumber}
                disabled={saving}
                onChange={(event) => set('customerDocNumber', event.target.value)}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks.customerDocNumber ?? null, touched)}
              />
              <FieldMessage
                issue={checks.customerDocNumber ?? null}
                touched={touched}
                validLabel="Documento aceptado."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-customer" className="text-[0.8125rem] font-medium">
                Nombre o razón social
              </label>
              <Input
                id="invoice-customer"
                value={draft.customerName}
                maxLength={BILLING_DESCRIPTION_MAX}
                disabled={saving}
                onChange={(event) => set('customerName', event.target.value)}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks.customerName ?? null, touched)}
              />
              <FieldMessage
                issue={checks.customerName ?? null}
                touched={touched}
                validLabel="Nombre aceptado."
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-igv" className="text-[0.8125rem] font-medium">
                Tasa de IGV
              </label>
              <Input
                id="invoice-igv"
                inputMode="decimal"
                value={draft.igvRate}
                disabled={saving}
                onChange={(event) => set('igvRate', event.target.value)}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks.igvRate ?? null, touched)}
              />
              <p className="text-xs text-muted-foreground">
                Por defecto {DEFAULT_IGV_RATE} (18 %). El servicio guarda la tasa en el comprobante.
              </p>
              <FieldMessage issue={checks.igvRate ?? null} touched={touched} validLabel="Tasa aceptada." />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-org-node" className="text-[0.8125rem] font-medium">
                Sede (UUID)
              </label>
              <Input
                id="invoice-org-node"
                className="font-mono text-xs"
                spellCheck={false}
                value={draft.orgNodeId}
                disabled={saving}
                onChange={(event) => set('orgNodeId', event.target.value)}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks.orgNodeId ?? null, touched)}
              />
              <FieldMessage issue={checks.orgNodeId ?? null} touched={touched} />
            </div>

            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <label htmlFor="invoice-cash-session" className="text-[0.8125rem] font-medium">
                Turno de caja (UUID, opcional)
              </label>
              <Input
                id="invoice-cash-session"
                className="font-mono text-xs"
                spellCheck={false}
                placeholder="En blanco: el API usa el turno abierto de la sede"
                value={draft.cashSessionId}
                disabled={saving}
                onChange={(event) => set('cashSessionId', event.target.value)}
                onBlur={() => setTouched(true)}
                {...fieldStateProps(checks.cashSessionId ?? null, touched)}
              />
              <FieldMessage issue={checks.cashSessionId ?? null} touched={touched} />
            </div>
          </div>

          {quoteId === null ? null : (
            <p className="rounded-md border border-border bg-secondary px-3.5 py-2 text-xs text-muted-foreground">
              Cotización de origen <span className="font-mono">{quoteId}</span>: viaja como{' '}
              <code className="font-mono">quoteId</code> y el comprobante queda enlazado a ella.
            </p>
          )}

          <div className="flex flex-col gap-3">
            <span className="text-[0.8125rem] font-medium">Líneas del comprobante</span>
            <BillingLinesField
              lines={lines}
              onChange={setLines}
              touched={touched}
              disabled={saving}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <MagneticCta type="submit" disabled={saving}>
              {saving ? 'Emitiendo…' : 'Emitir comprobante'}
            </MagneticCta>
            {issued === null ? null : <SavedPulse label="Comprobante emitido" resetKey={issued.id} />}
          </div>
        </form>

        {issued === null ? null : (
          <div className="sd-rise mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-secondary px-4 py-3">
            <span className="tabular text-[0.8125rem] font-medium">
              {issued.serie}-{String(issued.numero).padStart(8, '0')}
            </span>
            <span className="text-xs text-muted-foreground">
              {billingDocumentTypeLabel(issued.customerDocType)} {issued.customerDocNumber} ·{' '}
              {issued.customerName}
            </span>
            <span className="tabular text-xs">total {formatPen(issued.total)}</span>
            <Badge variant={fiscalStatusVariant(issued.fiscalStatus)}>
              fiscal {fiscalStatusLabel(issued.fiscalStatus)}
            </Badge>
            <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
              id {shortId(issued.id)}
            </span>
          </div>
        )}

        {failure === null ? null : (
          <FailurePanel className="mt-4" title="El comprobante no se emitió" failure={failure} />
        )}
      </CardContent>
    </Card>
  );
}
