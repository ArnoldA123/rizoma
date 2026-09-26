'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  INVOICE_STATUSES,
  invoiceListSchema,
  type CashSessionRecord,
  type InvoiceRecord,
} from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SkeletonRows } from '@/components/ui/skeleton';
import { CashSessionPanel } from '@/components/salud/cash-session-panel';
import { ViewSelector } from '@/components/views/view-selector';
import { InvoiceDetailPanel } from '@/components/salud/invoice-detail-panel';
import { InvoiceIssueForm, type InvoiceDraftSeed } from '@/components/salud/invoice-issue-form';
import { QuotesPanel } from '@/components/salud/quotes-panel';
import { EmptyState, FailurePanel } from '@/components/salud/states';
import { requestJson } from '@/lib/api-client';
import { withSavedView } from '@/lib/views-api';
import { DEV_IDENTITY } from '@/lib/config';
import { formatPen, formatUtcStamp, shortId } from '@/lib/format';
import {
  billingDocumentTypeLabel,
  fiscalStatusLabel,
  fiscalStatusVariant,
  invoiceStatusLabel,
  invoiceStatusVariant,
} from '@/lib/labels';
import { mergeInvoice, PAGE_SIZE, paginate } from '@/lib/salud-select';
import { useResource } from '@/lib/use-resource';
import { cn } from '@/lib/utils';

/**
 * `/salud/caja` — the billing screen of the Salud vertical.
 *
 * What this screen is allowed to see is the point of the whole separation:
 * `invoice.issue` is held by caja alone, and the billing contract carries no
 * clinical field at all — the documents here name a *customer*, a document
 * number, amounts and a fiscal state, and nothing else. There is no link from
 * this screen to a patient file, and no clinical field it could render even if
 * one arrived, because `@rizoma/contracts` drops anything the API did not
 * declare.
 *
 * The invoice list is server-backed: `GET /billing/invoices` answers the scope
 * capped at 200 rows with optional shift/status/date filters, and this screen
 * sends exactly the filters the operator sets. A freshly issued or updated
 * document is merged into the visible rows and the next read reconciles the
 * view with the API; any other document still opens by identifier. The API is
 * the authority for both.
 */
export interface CajaBoardProps {
  readonly role: string | null;
  readonly className?: string;
}

/** Filters of the invoice list; every field empty means "no filter". */
interface InvoiceFilters {
  readonly cashSession: string;
  readonly status: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_INVOICE_FILTERS: InvoiceFilters = { cashSession: '', status: '', from: '', to: '' };

/** Path of `GET /v1/billing/invoices` with the saved view plus exactly the filters the user set. */
function invoicesPath(filters: InvoiceFilters, savedViewId: string | null): string {
  // `withSavedView` names the `?saved_view_id=` suffix once; the remaining
  // filters join with `&` when the suffix is present, `?` when it is not.
  const base = withSavedView('/billing/invoices', savedViewId);
  const params = new URLSearchParams();
  if (filters.cashSession.trim() !== '') params.set('cashSession', filters.cashSession.trim());
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.from !== '') params.set('from', filters.from);
  if (filters.to !== '') params.set('to', filters.to);
  const query = params.toString();
  if (query === '') return base;
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

/** Reads the invoice list through the proxy, validated by the billing contract. */
async function readInvoices(
  filters: InvoiceFilters,
  savedViewId: string | null,
  signal: AbortSignal,
): Promise<readonly InvoiceRecord[]> {
  const rows = await requestJson(invoicesPath(filters, savedViewId), invoiceListSchema, { signal });
  return rows ?? [];
}

export function CajaBoard({ role, className }: CajaBoardProps) {
  const [session, setSession] = useState<CashSessionRecord | null>(null);
  const [filters, setFilters] = useState<InvoiceFilters>(EMPTY_INVOICE_FILTERS);
  // The active saved view narrows the server list via `?saved_view_id=`; null
  // reads the unfiltered scope. The id joins the resource key so a pick
  // refetches through the same path as a filter change.
  const [viewId, setViewId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');
  const [seed, setSeed] = useState<InvoiceDraftSeed | null>(null);

  // Sede the forms prefill with: the shift this session opened, else the local
  // development value. Every form also remembers the last real row it read.
  const defaultOrgNodeId = session?.orgNodeId ?? DEV_IDENTITY.orgNodeId;

  const filterKey = `${filters.cashSession.trim()}|${filters.status}|${filters.from}|${filters.to}|${viewId ?? ''}`;
  const invoices = useResource<readonly InvoiceRecord[]>(`invoices:${filterKey}`, (signal) =>
    readInvoices(filters, viewId, signal),
  );
  const rows = invoices.data ?? [];
  const current = useMemo(() => paginate(rows, page), [rows, page]);

  const selected = useMemo(
    () => rows.find((invoice) => invoice.id === selectedId) ?? null,
    [rows, selectedId],
  );

  function updateFilters(next: InvoiceFilters): void {
    setFilters(next);
    setPage(1);
  }

  // A freshly issued or updated document joins the visible rows at once; the
  // silent reload reconciles the view with the API (a row a filter excludes
  // leaves on that read). The detail by identifier stays available regardless.
  function handleInvoiceChanged(invoice: InvoiceRecord): void {
    invoices.setData((existing) => mergeInvoice(existing, invoice));
    invoices.reloadSilently();
  }

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <CashSessionPanel
        session={session}
        defaultOrgNodeId={defaultOrgNodeId}
        onOpened={(opened) => setSession(opened)}
        onClosed={(closed) => setSession(closed)}
      />

      <QuotesPanel defaultOrgNodeId={defaultOrgNodeId} onIssueFromQuote={setSeed} />

      <InvoiceIssueForm
        seed={seed}
        defaultOrgNodeId={defaultOrgNodeId}
        cashSessionId={session?.status === 'open' ? session.id : null}
        onIssued={(invoice) => {
          handleInvoiceChanged(invoice);
          setSelectedId(invoice.id);
          setSeed(null);
        }}
      />

      <Card>
        <CardHeader>
          <CardEyebrow>Comprobantes</CardEyebrow>
          <CardTitle as="h2">Comprobantes del alcance</CardTitle>
          <CardDescription>
            La lista la responde <span className="font-mono">GET /v1/billing/invoices</span> (hasta
            200 filas por respuesta y sin cursor en MVP1): los filtros viajan al API y el paginador
            indica cuántas de la página cargada se están mostrando. El estado fiscal{' '}
            <span className="font-medium">pendiente</span> se muestra en cada fila: un comprobante
            emitido no es un comprobante aceptado por el adaptador.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <ViewSelector
            entity="invoices"
            selectedId={viewId}
            onSelect={(next) => {
              setViewId(next);
              setPage(1);
            }}
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-filter-session" className="text-[0.8125rem] font-medium">
                Turno de caja
              </label>
              <Input
                id="invoice-filter-session"
                className="font-mono text-xs"
                spellCheck={false}
                placeholder="UUID del turno (vacío: todos)"
                value={filters.cashSession}
                onChange={(event) => updateFilters({ ...filters, cashSession: event.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-filter-status" className="text-[0.8125rem] font-medium">
                Estado comercial
              </label>
              <Select
                id="invoice-filter-status"
                value={filters.status}
                onChange={(event) => updateFilters({ ...filters, status: event.target.value })}
              >
                <option value="">Todos</option>
                {INVOICE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {invoiceStatusLabel(status)}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-filter-from" className="text-[0.8125rem] font-medium">
                Emitidos desde
              </label>
              <Input
                id="invoice-filter-from"
                type="date"
                value={filters.from}
                onChange={(event) => updateFilters({ ...filters, from: event.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-filter-to" className="text-[0.8125rem] font-medium">
                Emitidos hasta
              </label>
              <Input
                id="invoice-filter-to"
                type="date"
                value={filters.to}
                onChange={(event) => updateFilters({ ...filters, to: event.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="tabular text-xs text-muted-foreground">
              {invoices.loading
                ? 'leyendo…'
                : `${current.from}–${current.to} de ${current.total} comprobantes`}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {session?.status === 'open' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => updateFilters({ ...filters, cashSession: session.id })}
                >
                  Ver turno actual
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateFilters(EMPTY_INVOICE_FILTERS)}
              >
                Limpiar filtros
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={invoices.reload}
                disabled={invoices.loading}
              >
                Actualizar
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="invoice-lookup" className="sr-only">
              Identificador del comprobante
            </label>
            <Input
              id="invoice-lookup"
              className="font-mono text-xs sm:max-w-sm"
              spellCheck={false}
              placeholder="UUID del comprobante"
              value={lookup}
              onChange={(event) => setLookup(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={lookup.trim() === ''}
              onClick={() => setSelectedId(lookup.trim())}
            >
              Abrir detalle
            </Button>
            <Link
              href="/salud/tableros/caja"
              className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'ml-auto')}
            >
              Ver tablero de caja
            </Link>
          </div>

          {invoices.loading ? <SkeletonRows rows={4} /> : null}

          {!invoices.loading && invoices.failure !== null ? (
            <FailurePanel
              title="No se pudieron leer los comprobantes"
              failure={invoices.failure}
              onRetry={invoices.reload}
            />
          ) : null}

          {!invoices.loading && invoices.failure === null && rows.length === 0 ? (
            <EmptyState
              eyebrow="Sin comprobantes"
              title="El alcance no tiene comprobantes con esos filtros"
              description="Emita el primero con el formulario de arriba, limpie los filtros, o abra un comprobante existente con su identificador. El detalle muestra el par fiscal y los cobros registrados."
            />
          ) : null}

          {rows.length === 0 ? null : (
            <ul className="flex flex-col">
              {current.items.map((invoice: InvoiceRecord) => (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3.5 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tabular text-[0.9375rem] font-medium">
                        {invoice.serie}-{String(invoice.numero).padStart(8, '0')}
                      </span>
                      <Badge variant={invoiceStatusVariant(invoice.status)}>
                        {invoiceStatusLabel(invoice.status)}
                      </Badge>
                      <Badge variant={fiscalStatusVariant(invoice.fiscalStatus)}>
                        fiscal {fiscalStatusLabel(invoice.fiscalStatus)}
                      </Badge>
                    </div>
                    <span className="tabular text-xs text-muted-foreground">
                      {billingDocumentTypeLabel(invoice.customerDocType)} {invoice.customerDocNumber} ·{' '}
                      {invoice.customerName} · {formatPen(invoice.total)} ·{' '}
                      {formatUtcStamp(invoice.issuedAt)} ·{' '}
                      <span className="font-mono">{shortId(invoice.id)}</span>
                    </span>
                  </div>
                  <Button
                    variant={selectedId === invoice.id ? 'ghost' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedId(invoice.id)}
                  >
                    {selectedId === invoice.id ? 'En detalle' : 'Ver detalle'}
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

      {selectedId === null ? null : (
        <>
          {selected === null ? (
            <p className="text-xs text-muted-foreground">
              Leyendo el comprobante <span className="font-mono">{shortId(selectedId)}</span> desde el
              API. Si el identificador no existe en el alcance, el detalle responde 404 con su
              envelope.
            </p>
          ) : null}
          <InvoiceDetailPanel invoiceId={selectedId} onUpdated={handleInvoiceChanged} />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Pantalla de caja para el rol {role ?? 'sin resolver'}. El contrato de facturación no declara
        ningún campo clínico: el comprobante nombra un cliente, un documento, importes y un estado
        fiscal. La ruta solo la abre caja; médico y recepción reciben la denegación antes de que
        exista una sola llamada. Si necesita este acceso, avise a jefatura o a soporte.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer underline underline-offset-2">Copiar detalle</summary>
        <pre className="tabular mt-2 overflow-x-auto rounded-md border border-border bg-secondary p-2 font-mono break-all whitespace-pre-wrap">
          {`code: access.denied\nreason: role.denied\nstatus: 403\naction: invoice.issue`}
        </pre>
      </details>
    </div>
  );
}
