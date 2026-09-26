'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  PAYMENT_METHOD_SUGGESTIONS,
  checkAmountWithinPending,
  checkRequiredText,
  firstIssue,
  pendingInvoiceTotal,
  round2,
  type FieldCheck,
  type InvoiceRecord,
  type InvoiceWithFiscal,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, fieldStateProps } from '@/components/ui/field-feedback';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { FailurePanel, WriteResult } from '@/components/salud/states';
import { formatPen, formatRate, formatUtcStamp } from '@/lib/format';
import {
  billingDocumentTypeLabel,
  fiscalStatusLabel,
  fiscalStatusVariant,
  invoiceStatusLabel,
  invoiceStatusVariant,
  paymentMethodLabel,
  PAYMENT_STATUS_LABELS,
} from '@/lib/labels';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { getInvoice, listCashSessions, listQuotes, payInvoice, voidInvoice } from '@/lib/salud-api';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * Invoice detail: the fiscal pair, the registered payments, and the two
 * lifecycle writes that act on the document.
 *
 * The read is `GET /billing/invoices/:id` and nothing else exists in MVP1: there
 * is no invoice list, so the screen reaches a document by the identifier it just
 * issued or looked up. The detail is the only place the *fiscal* state of a
 * document is visible, and it stays visible next to the pay/void buttons on
 * purpose — a `pending` invoice is not a finished invoice.
 *
 * Pay and void are **optimistic**, and the revert is visible:
 *
 *   - the status flips and the pending saldo moves on the click;
 *   - the API's answer replaces the local guess, and a silent reload reads the
 *     authoritative payment list (the pay endpoint answers with the invoice, not
 *     with its payments);
 *   - on a refusal the previous row comes back and the panel plays `sd-revert`
 *     while naming the `code`, `reason` and `traceId` — the same honest rollback
 *     the episodes panel uses.
 */
export interface InvoiceDetailPanelProps {
  readonly invoiceId: string;
  /** Called with the API's invoice after a successful pay or void. */
  readonly onUpdated: (invoice: InvoiceRecord) => void;
  readonly className?: string;
}

export function InvoiceDetailPanel({ invoiceId, onUpdated, className }: InvoiceDetailPanelProps) {
  const detail = useResource<InvoiceWithFiscal>(`invoice:${invoiceId}`, (signal) =>
    getInvoice(invoiceId, signal),
  );
  const snapshot = useRef<InvoiceWithFiscal | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [reverted, setReverted] = useState(false);
  const [pendingPayment, setPendingPayment] = useState<{ method: string; amount: number } | null>(null);
  const [pendingVoid, setPendingVoid] = useState(false);
  // Turno y cotización por fecha/estado y cliente: los ids del comprobante se
  // resuelven en el navegador contra las listas del alcance. Sin lectura
  // auxiliar, la fila muestra el id corto.
  const [sessionLabels, setSessionLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const [quoteLabels, setQuoteLabels] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const signal = controller.signal;
    Promise.allSettled([listCashSessions({}, signal), listQuotes(signal)]).then(
      ([sessions, quotes]) => {
        if (!active) return;
        if (sessions.status === 'fulfilled') {
          setSessionLabels(
            new Map(
              sessions.value.map((row) => [
                row.id,
                `${formatUtcStamp(row.openedAt)} · ${row.status === 'open' ? 'abierto' : 'cerrado'}`,
              ]),
            ),
          );
        }
        if (quotes.status === 'fulfilled') {
          setQuoteLabels(
            new Map(
              quotes.value.map((row) => [
                row.id,
                `${row.customerName} · ${formatPen(row.total)} · ${formatUtcStamp(row.createdAt)}`,
              ]),
            ),
          );
        }
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!reverted) return;
    const timer = window.setTimeout(() => setReverted(false), 600);
    return () => window.clearTimeout(timer);
  }, [reverted]);

  const invoice = detail.data;
  if (invoice === null) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardEyebrow>Comprobante</CardEyebrow>
          <CardTitle as="h2">Detalle del comprobante</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.loading ? <Skeleton className="h-24 w-full" /> : null}
          {!detail.loading && detail.failure !== null ? (
            <FailurePanel
              title="No se pudo leer el comprobante"
              failure={detail.failure}
              onRetry={detail.reload}
            />
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const payments = invoice.payments;
  const pending = pendingInvoiceTotal(invoice, payments);
  const canPay = invoice.status === 'issued' || invoice.status === 'partially_paid';
  const canVoid = canPay || invoice.status === 'draft';

  const revert = (): void => {
    if (snapshot.current !== null) detail.setData(snapshot.current);
    setReverted(true);
  };

  const handlePay = async (input: {
    method: string;
    amount: number;
    externalRef: string;
  }): Promise<void> => {
    snapshot.current = invoice;
    setFailure(null);
    setPendingPayment(input);
    // Optimistic: the saldo and the commercial status move before the round trip.
    const nextStatus: string =
      round2(input.amount) >= pending ? 'paid' : invoice.status === 'issued' ? 'partially_paid' : invoice.status;
    detail.setData({ ...invoice, status: nextStatus });

    try {
      const updated = await payInvoice(invoice.id, {
        method: input.method,
        amount: input.amount,
        ...(input.externalRef === '' ? {} : { externalRef: input.externalRef }),
      });
      detail.setData((current) => (current === null ? current : { ...current, ...updated }));
      onUpdated(updated);
      // The authoritative payment list comes from the read endpoint.
      detail.reloadSilently();
    } catch (error) {
      revert();
      setFailure(classifyApiError(error));
    } finally {
      setPendingPayment(null);
    }
  };

  const handleVoid = async (motivo: string): Promise<void> => {
    snapshot.current = invoice;
    setFailure(null);
    setPendingVoid(true);
    detail.setData({ ...invoice, status: 'voided' });
    try {
      const updated = await voidInvoice(invoice.id, { motivo });
      detail.setData((current) => (current === null ? current : { ...current, ...updated }));
      onUpdated(updated);
      detail.reloadSilently();
    } catch (error) {
      revert();
      setFailure(classifyApiError(error));
    } finally {
      setPendingVoid(false);
    }
  };

  return (
    <Card className={cn(className, reverted && 'sd-revert')}>
      <CardHeader>
        <CardEyebrow>Comprobante emitido</CardEyebrow>
        <CardTitle as="h2" className="tabular">
          {invoice.serie}-{String(invoice.numero).padStart(8, '0')}
        </CardTitle>
        <CardDescription>
          El par fiscal (estado, adaptador y payload) se muestra tal como lo devuelve el API. El IGV
          no se recalcula aquí: los importes son los del comprobante y el saldo pendiente es la resta
          de los cobros registrados.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={invoiceStatusVariant(invoice.status)}>
            {invoiceStatusLabel(invoice.status)}
          </Badge>
          <Badge variant={fiscalStatusVariant(invoice.fiscalStatus)}>
            fiscal {fiscalStatusLabel(invoice.fiscalStatus)}
          </Badge>
          <span className="tabular text-xs text-muted-foreground">
            {billingDocumentTypeLabel(invoice.customerDocType)} {invoice.customerDocNumber} ·{' '}
            {invoice.customerName} · {formatPen(invoice.total)} · {formatUtcStamp(invoice.issuedAt)}
          </span>
          <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">
            id {invoice.id}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => detail.reload()}
            disabled={detail.loading}
          >
            Releer
          </Button>
        </div>

        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <AmountRow label="Subtotal" value={formatPen(invoice.subtotal)} />
          <AmountRow label={`IGV (${formatRate(invoice.igvRate)})`} value={formatPen(invoice.igvTotal)} />
          <AmountRow label="Total" value={formatPen(invoice.total)} strong />
          <AmountRow label="Saldo pendiente" value={formatPen(pending)} strong />
          <AmountRow label="Emitido" value={formatUtcStamp(invoice.issuedAt)} />
          <AmountRow
            label="Turno de caja"
            value={
              invoice.cashSessionId === null
                ? '—'
                : (sessionLabels.get(invoice.cashSessionId) ?? invoice.cashSessionId.slice(0, 8) + '…')
            }
          />
          <AmountRow
            label="Cotización de origen"
            value={
              invoice.quoteId === null
                ? '—'
                : (quoteLabels.get(invoice.quoteId) ?? invoice.quoteId.slice(0, 8) + '…')
            }
          />
          <AmountRow label="Adaptador fiscal" value={invoice.fiscalAdapter} />
        </dl>

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer underline underline-offset-2">Copiar detalle</summary>
          <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
            {`comprobante: ${invoice.serie}-${String(invoice.numero).padStart(8, '0')}\nid: ${invoice.id}\nturno: ${invoice.cashSessionId ?? '—'}\ncotizacion: ${invoice.quoteId ?? '—'}`}
          </pre>
        </details>

        <div className="flex flex-col gap-2">
          <span className="text-[0.8125rem] font-medium">Payload fiscal</span>
          {Object.keys(invoice.fiscalPayload).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              El API todavía no tiene payload para este comprobante: el adaptador manual lo deja vacío
              hasta que los workers lo envíen.
            </p>
          ) : (
            <pre className="max-h-56 overflow-auto rounded-md border border-border bg-secondary p-3 text-[0.6875rem] leading-5">
              {JSON.stringify(invoice.fiscalPayload, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[0.8125rem] font-medium">
            Cobros registrados ({payments.length})
          </span>
          {pendingPayment !== null ? (
            <p role="status" className="sd-rise text-xs text-muted-foreground">
              Registrando {formatPen(pendingPayment.amount)} en {paymentMethodLabel(pendingPayment.method)}…
            </p>
          ) : null}
          {payments.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Sin cobros registrados. El saldo pendiente es el total del comprobante.
            </p>
          ) : (
            <ul className="flex flex-col">
              {payments.map((payment) => (
                <li
                  key={payment.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0"
                >
                  <span className="tabular text-[0.8125rem]">
                    {paymentMethodLabel(payment.method)} · {formatPen(payment.amount)}
                  </span>
                  <span className="tabular text-xs text-muted-foreground">
                    {PAYMENT_STATUS_LABELS[payment.status] ?? payment.status} ·{' '}
                    {formatUtcStamp(payment.paidAt)}
                    {payment.externalRef === null ? '' : ` · ref ${payment.externalRef}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <WriteResult failure={failure} success={null} />

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Keyed by the saldo: after a successful payment the form resets with
              the new pending amount instead of keeping a stale value. */}
          {canPay ? (
            <PayForm
              key={pending}
              pending={pending}
              saving={pendingPayment !== null}
              onSubmit={handlePay}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {invoice.status === 'voided'
                ? 'El comprobante está anulado: el API no admite cobros sobre él.'
                : `El comprobante está ${invoiceStatusLabel(invoice.status).toLowerCase()}: no hay saldo por cobrar.`}
            </p>
          )}

          {canVoid ? (
            <VoidForm saving={pendingVoid} onSubmit={handleVoid} />
          ) : (
            <p className="text-xs text-muted-foreground">
              La anulación solo aplica a un comprobante en borrador, emitido o con pago parcial.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AmountRow({
  label,
  value,
  strong = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('tabular text-[0.8125rem]', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}

interface PayFormProps {
  readonly pending: number;
  readonly saving: boolean;
  readonly onSubmit: (input: { method: string; amount: number; externalRef: string }) => Promise<void>;
}

function PayForm({ pending, saving, onSubmit }: PayFormProps) {
  const [method, setMethod] = useState<string>(PAYMENT_METHOD_SUGGESTIONS[0]);
  const [amount, setAmount] = useState(() => String(pending));
  const [externalRef, setExternalRef] = useState('');
  const [touched, setTouched] = useState(false);

  const checks: Readonly<Record<string, FieldCheck>> = {
    amount: checkAmountWithinPending('amount', amount, pending),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (firstIssue(checks) !== null) return;
    await onSubmit({ method, amount: Number(amount), externalRef: externalRef.trim() });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
      <span className="text-[0.8125rem] font-medium">Registrar cobro</span>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pay-method" className="text-xs text-muted-foreground">
          Método
        </label>
        <Select
          id="pay-method"
          value={method}
          disabled={saving}
          onChange={(event) => setMethod(event.target.value)}
        >
          {PAYMENT_METHOD_SUGGESTIONS.map((option) => (
            <option key={option} value={option}>
              {paymentMethodLabel(option)}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pay-amount" className="text-xs text-muted-foreground">
          Importe (saldo {formatPen(pending)})
        </label>
        <Input
          id="pay-amount"
          inputMode="decimal"
          value={amount}
          disabled={saving}
          onChange={(event) => setAmount(event.target.value)}
          onBlur={() => setTouched(true)}
          {...fieldStateProps(checks.amount ?? null, touched)}
        />
        <FieldMessage
          issue={checks.amount ?? null}
          touched={touched}
          validLabel="Importe dentro del saldo pendiente."
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pay-ref" className="text-xs text-muted-foreground">
          Referencia externa (opcional)
        </label>
        <Input
          id="pay-ref"
          value={externalRef}
          disabled={saving}
          placeholder="N.º de operación"
          onChange={(event) => setExternalRef(event.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" type="submit" disabled={saving}>
          {saving ? 'Registrando…' : 'Registrar cobro'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => setAmount(String(pending))}
        >
          Usar el saldo
        </Button>
        <span className="text-xs text-muted-foreground">
          El API rechaza un importe mayor al saldo pendiente.
        </span>
      </div>
    </form>
  );
}

interface VoidFormProps {
  readonly saving: boolean;
  readonly onSubmit: (motivo: string) => Promise<void>;
}

function VoidForm({ saving, onSubmit }: VoidFormProps) {
  const [motivo, setMotivo] = useState('');
  const [touched, setTouched] = useState(false);

  const checks: Readonly<Record<string, FieldCheck>> = {
    motivo: checkRequiredText('motivo', motivo, 160),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (firstIssue(checks) !== null) return;
    await onSubmit(motivo.trim());
    setMotivo('');
    setTouched(false);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
      <span className="text-[0.8125rem] font-medium">Anular comprobante</span>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="void-motivo" className="text-xs text-muted-foreground">
          Motivo de la anulación
        </label>
        <Input
          id="void-motivo"
          value={motivo}
          maxLength={160}
          disabled={saving}
          placeholder="Error de digitación"
          onChange={(event) => setMotivo(event.target.value)}
          onBlur={() => setTouched(true)}
          {...fieldStateProps(checks.motivo ?? null, touched)}
        />
        <FieldMessage issue={checks.motivo ?? null} touched={touched} validLabel="Motivo aceptado." />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="danger" size="sm" type="submit" disabled={saving}>
          {saving ? 'Anulando…' : 'Anular'}
        </Button>
        <span className="text-xs text-muted-foreground">
          El motivo queda en la auditoría del API; la anulación no borra el folio.
        </span>
      </div>
    </form>
  );
}
