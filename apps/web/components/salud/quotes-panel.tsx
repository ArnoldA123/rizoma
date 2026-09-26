'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  BILLING_DESCRIPTION_MAX,
  checkRequiredText,
  checkUuidField,
  firstIssue,
  type FieldCheck,
  type QuoteRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldMessage, SavedPulse, fieldStateProps } from '@/components/ui/field-feedback';
import { EntitySelector, type EntityItem } from '@/components/ui/entity-select';
import { Input } from '@/components/ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  BillingLinesField,
  firstLineIssue,
  newBillingLineDraft,
  toBillingLines,
  type BillingLineDraft,
} from '@/components/salud/billing-lines-field';
import { EmptyState, FailurePanel, WriteResult } from '@/components/salud/states';
import { formatPen, formatUtcStamp, shortId } from '@/lib/format';
import { quoteStatusLabel } from '@/lib/labels';
import { classifyApiError, type ApiFailure } from '@/lib/salud-errors';
import { createQuote, listQuotes } from '@/lib/salud-api';
import { listOrgNodes } from '@/lib/org-api';
import { PAGE_SIZE, paginate } from '@/lib/salud-select';
import { useResource } from '@/lib/use-resource';
import type { InvoiceDraftSeed } from '@/components/salud/invoice-issue-form';

/**
 * Quotes of the scope: list, create, and hand a line set to the issue form.
 *
 * `GET /v1/billing/quotes` answers the whole scope capped at 200 rows and takes
 * no filter, so the list paginates in the browser and says so. The create form
 * omits `total`: the service prices the lines (`computeInvoiceTotals` with a 0
 * rate) and the quote then carries the server's number, never a number this
 * screen invented.
 */
export interface QuotesPanelProps {
  /** Sede prefill, from the last real row the screen read. */
  readonly defaultOrgNodeId: string;
  /** Hands a priced quote to the issue form of the same screen. */
  readonly onIssueFromQuote: (seed: InvoiceDraftSeed) => void;
  readonly className?: string;
}

export function QuotesPanel({ defaultOrgNodeId, onIssueFromQuote, className }: QuotesPanelProps) {
  const quotes = useResource<QuoteRecord[]>('quotes', (signal) => listQuotes(signal));
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);

  const rows = quotes.data ?? [];
  const current = paginate(rows, page);

  function handleCreated(quote: QuoteRecord): void {
    quotes.setData((existing) => [quote, ...(existing ?? [])]);
    setPage(1);
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardEyebrow>Cotizaciones</CardEyebrow>
        <CardTitle as="h2">Cotizaciones del alcance</CardTitle>
        <CardDescription>
          Hasta 200 filas por respuesta y sin cursor en MVP1: el paginador indica cuántas de la
          página cargada se están mostrando. Una cotización aceptada se convierte en comprobante con
          el botón de cada fila.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            {quotes.loading
              ? 'leyendo…'
              : `${current.from}–${current.to} de ${current.total} cotizaciones`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={quotes.reload}
              disabled={quotes.loading}
            >
              Actualizar
            </Button>
            <Button variant="outline" size="sm" onClick={() => setFormOpen((open) => !open)}>
              {formOpen ? 'Cerrar formulario' : 'Nueva cotización'}
            </Button>
          </div>
        </div>

        {formOpen ? (
          <QuoteForm
            defaultOrgNodeId={defaultOrgNodeId}
            onCreated={handleCreated}
            onClose={() => setFormOpen(false)}
          />
        ) : null}

        {quotes.loading ? <SkeletonRows rows={4} /> : null}

        {!quotes.loading && quotes.failure !== null ? (
          <FailurePanel
            title="No se pudieron leer las cotizaciones"
            failure={quotes.failure}
            onRetry={quotes.reload}
          />
        ) : null}

        {!quotes.loading && quotes.failure === null && rows.length === 0 ? (
          <EmptyState
            eyebrow="Sin cotizaciones"
            title="La sede no tiene cotizaciones"
            description="El API respondió con una lista válida y vacía. Una cotización se registra desde aquí y luego se emite como comprobante desde su propia fila."
          >
            <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
              Registrar cotización
            </Button>
          </EmptyState>
        ) : null}

        {rows.length === 0 ? null : (
          <ul className="flex flex-col">
            {current.items.map((quote) => (
              <li
                key={quote.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.9375rem] font-medium">{quote.customerName}</span>
                    <Badge variant="outline">{quoteStatusLabel(quote.status)}</Badge>
                  </div>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatPen(quote.total)} · {quote.items.length} línea
                    {quote.items.length === 1 ? '' : 's'} · {formatUtcStamp(quote.createdAt)} ·{' '}
                    <span className="font-mono">{shortId(quote.id)}</span>
                  </span>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onIssueFromQuote({
                      quoteId: quote.id,
                      customerName: quote.customerName,
                      items: linesFromQuote(quote),
                    })
                  }
                >
                  Emitir comprobante
                </Button>
              </li>
            ))}
          </ul>
        )}

        {current.pageCount > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={current.page <= 1}
              onClick={() => setPage(current.page - 1)}
            >
              Anterior
            </Button>
            <span className="tabular text-xs text-muted-foreground">
              Página {current.page} de {current.pageCount} · {PAGE_SIZE} filas por página
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={current.page >= current.pageCount}
              onClick={() => setPage(current.page + 1)}
            >
              Siguiente
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Draft lines of a quote. The quote's `items` is a JSONB bag (`unknown[]`), so
 * each entry is read defensively: a field the API did not send becomes an empty
 * draft line the user completes, never a `NaN` in the request.
 */
function linesFromQuote(quote: QuoteRecord): readonly BillingLineDraft[] {
  const lines = quote.items.map((item) => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    return newBillingLineDraft({
      description: typeof record.description === 'string' ? record.description : '',
      quantity: typeof record.quantity === 'number' ? String(record.quantity) : '1',
      unitPrice: typeof record.unitPrice === 'number' ? String(record.unitPrice) : '',
    });
  });
  return lines.length === 0 ? [newBillingLineDraft()] : lines;
}

interface QuoteFormProps {
  readonly defaultOrgNodeId: string;
  readonly onCreated: (quote: QuoteRecord) => void;
  readonly onClose: () => void;
}

function QuoteForm({ defaultOrgNodeId, onCreated, onClose }: QuoteFormProps) {
  const [orgNodeId, setOrgNodeId] = useState(defaultOrgNodeId);
  const [customerName, setCustomerName] = useState('');
  const [lines, setLines] = useState<readonly BillingLineDraft[]>(() => [newBillingLineDraft()]);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [created, setCreated] = useState<QuoteRecord | null>(null);
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

  const checks: Readonly<Record<string, FieldCheck>> = {
    orgNodeId: checkUuidField('orgNodeId', orgNodeId),
    customerName: checkRequiredText('customerName', customerName, BILLING_DESCRIPTION_MAX),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (firstIssue(checks) !== null || firstLineIssue(lines) !== null) return;

    setSaving(true);
    try {
      const quote = await createQuote({
        orgNodeId: orgNodeId.trim(),
        customerName: customerName.trim(),
        items: toBillingLines(lines),
      });
      setCreated(quote);
      onCreated(quote);
      setCustomerName('');
      setLines([newBillingLineDraft()]);
      setTouched(false);
    } catch (error) {
      setFailure(classifyApiError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="sd-rise flex flex-col gap-4 rounded-md border border-border bg-secondary p-4"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="quote-customer" className="text-[0.8125rem] font-medium">
            Cliente
          </label>
          <Input
            id="quote-customer"
            value={customerName}
            maxLength={BILLING_DESCRIPTION_MAX}
            disabled={saving}
            onChange={(event) => setCustomerName(event.target.value)}
            onBlur={() => setTouched(true)}
            {...fieldStateProps(checks.customerName ?? null, touched)}
          />
          <FieldMessage
            issue={checks.customerName ?? null}
            touched={touched}
            validLabel="Cliente aceptado."
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <EntitySelector
            label="Sede"
            items={sedeItems}
            value={orgNodeId === '' ? null : orgNodeId}
            onChange={(id) => {
              setOrgNodeId(id ?? '');
              setTouched(true);
            }}
            placeholder="Seleccionar sede…"
            searchPlaceholder="Buscar por nombre…"
          />
          <FieldMessage issue={checks.orgNodeId ?? null} touched={touched} />
        </div>
      </div>

      <BillingLinesField lines={lines} onChange={setLines} touched={touched} disabled={saving} />

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" type="submit" disabled={saving}>
          {saving ? 'Registrando…' : 'Registrar cotización'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          Cerrar
        </Button>
        <span className="text-xs text-muted-foreground">
          El total lo calcula el API al registrar las líneas.
        </span>
        {created === null ? null : <SavedPulse label="Cotización registrada" resetKey={created.id} />}
      </div>

      <WriteResult
        failure={failure}
        success={
          created === null
            ? null
            : `Cotización ${shortId(created.id)} registrada por ${formatPen(created.total)}.`
        }
      />
    </form>
  );
}
