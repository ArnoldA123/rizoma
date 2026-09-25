'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { CashSessionRecord, InvoiceRecord } from '@rizoma/contracts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardEyebrow, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CashSessionPanel } from '@/components/salud/cash-session-panel';
import { InvoiceDetailPanel } from '@/components/salud/invoice-detail-panel';
import { InvoiceIssueForm, type InvoiceDraftSeed } from '@/components/salud/invoice-issue-form';
import { QuotesPanel } from '@/components/salud/quotes-panel';
import { EmptyState } from '@/components/salud/states';
import { DEV_IDENTITY } from '@/lib/config';
import { formatPen, formatUtcStamp, shortId } from '@/lib/format';
import {
  billingDocumentTypeLabel,
  fiscalStatusLabel,
  fiscalStatusVariant,
  invoiceStatusLabel,
  invoiceStatusVariant,
} from '@/lib/labels';
import { mergeInvoice } from '@/lib/salud-select';
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
 * One honest limitation, stated in the UI: MVP1 has **no invoice list endpoint**
 * (`GET /billing/invoices/:id` is the only read), so the panel keeps the
 * documents issued in this session and lets an operator open any other one by
 * identifier. The API is the authority for both; the list is a convenience of
 * the session, not a second source of truth.
 */
export interface CajaBoardProps {
  readonly role: string | null;
  readonly className?: string;
}

export function CajaBoard({ role, className }: CajaBoardProps) {
  const [session, setSession] = useState<CashSessionRecord | null>(null);
  const [issued, setIssued] = useState<readonly InvoiceRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');
  const [seed, setSeed] = useState<InvoiceDraftSeed | null>(null);

  // Sede the forms prefill with: the shift this session opened, else the local
  // development value. Every form also remembers the last real row it read.
  const defaultOrgNodeId = session?.orgNodeId ?? DEV_IDENTITY.orgNodeId;

  const selected = useMemo(
    () => issued.find((invoice) => invoice.id === selectedId) ?? null,
    [issued, selectedId],
  );

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
          setIssued((current) => mergeInvoice(current, invoice));
          setSelectedId(invoice.id);
          setSeed(null);
        }}
      />

      <Card>
        <CardHeader>
          <CardEyebrow>Comprobantes de la sesión</CardEyebrow>
          <CardTitle as="h2">Emitidos en esta sesión</CardTitle>
          <CardDescription>
            El estado fiscal <span className="font-medium">pendiente</span> se muestra en cada fila:
            un comprobante emitido no es un comprobante aceptado por el adaptador. MVP1 no expone un
            listado de comprobantes, así que aquí quedan los emitidos desde esta pantalla y cualquier
            otro se abre por su identificador.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
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

          {issued.length === 0 ? (
            <EmptyState
              eyebrow="Sin comprobantes en la sesión"
              title="Todavía no emitió comprobantes"
              description="Emita el primero con el formulario de arriba, o abra un comprobante existente con su identificador. El detalle muestra el par fiscal y los cobros registrados."
            />
          ) : (
            <ul className="flex flex-col">
              {issued.map((invoice) => (
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
          <InvoiceDetailPanel
            invoiceId={selectedId}
            onUpdated={(invoice) => setIssued((current) => mergeInvoice(current, invoice))}
          />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Pantalla de caja para el rol {role ?? 'sin resolver'}. El contrato de facturación no declara
        ningún campo clínico, y la ruta exige <code className="font-mono">invoice.issue</code>: médico
        y recepción reciben la denegación antes de que exista una sola llamada.
      </p>
    </div>
  );
}
