// Billing endpoint — thin HTTP skin over `billing.service.ts`
// (bases-consolidadas-v1.md §2.5, §6.1; peru-anexo-v1.md §3). No domain logic
// and no permission checks live here: every handler forwards the request-bound
// tenant client to the service, which owns the guard (`invoice.issue` for the
// caja role), the SQL and the write audit. The `Idempotency-Key` header is the
// only extra request fact the issue route needs, so it is read here and passed
// through unchanged.
import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import type { TenantScopedRequest } from '../tenant/tenant.middleware.ts';
import {
  actorFromRequest,
  closeCashSession,
  createQuote,
  getInvoiceWithFiscal,
  IDEMPOTENCY_KEY_HEADER,
  issueInvoice,
  listQuotes,
  openCashSession,
  payInvoice,
  voidInvoice,
  type CashSessionRecord,
  type InvoiceRecord,
  type InvoiceWithFiscal,
  type QuoteRecord,
} from './billing.service.ts';

@Controller('billing')
export class BillingController {
  /** `POST /v1/billing/cash-sessions/open` — opens the cashier shift. */
  @Post('cash-sessions/open')
  openCash(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<CashSessionRecord> {
    return openCashSession(actorFromRequest(req), body);
  }

  /** `POST /v1/billing/cash-sessions/close` — closes the cashier shift. */
  @Post('cash-sessions/close')
  closeCash(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<CashSessionRecord> {
    return closeCashSession(actorFromRequest(req), body);
  }

  /** `GET /v1/billing/quotes` — quotes inside the caller scope. */
  @Get('quotes')
  quotes(@Req() req: TenantScopedRequest): Promise<QuoteRecord[]> {
    return listQuotes(actorFromRequest(req));
  }

  /** `POST /v1/billing/quotes` — creates a draft quote. */
  @Post('quotes')
  createQuote(@Req() req: TenantScopedRequest, @Body() body: unknown): Promise<QuoteRecord> {
    return createQuote(actorFromRequest(req), body);
  }

  /** `POST /v1/billing/invoices/issue` — emits a manual invoice (idempotent). */
  @Post('invoices/issue')
  issue(
    @Req() req: TenantScopedRequest,
    @Body() body: unknown,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<InvoiceRecord> {
    return issueInvoice(actorFromRequest(req), body, idempotencyKey);
  }

  /** `POST /v1/billing/invoices/:id/pay` — registers one payment. */
  @Post('invoices/:id/pay')
  pay(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<InvoiceRecord> {
    return payInvoice(actorFromRequest(req), id, body);
  }

  /** `POST /v1/billing/invoices/:id/void` — voids the invoice with a motivo. */
  @Post('invoices/:id/void')
  void(
    @Req() req: TenantScopedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<InvoiceRecord> {
    return voidInvoice(actorFromRequest(req), id, body);
  }

  /** `GET /v1/billing/invoices/:id` — invoice + fiscal status/payload. */
  @Get('invoices/:id')
  invoice(@Req() req: TenantScopedRequest, @Param('id') id: string): Promise<InvoiceWithFiscal> {
    return getInvoiceWithFiscal(actorFromRequest(req), id);
  }
}
