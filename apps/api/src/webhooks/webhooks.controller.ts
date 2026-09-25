// Webhook endpoint — thin HTTP skin over `webhooks.ts` (W2).
// No domain logic and no permission checks live here: every handler forwards
// the request-bound tenant client to the service, which owns validation, the
// tenant-admin gate, the SQL and the write audit. Deliveries are read-only
// from the API; the worker owns their lifecycle.
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  actorFromWebhookRequest,
  createSubscription,
  getDelivery,
  listDeliveries,
  listSubscriptions,
  removeSubscription,
  rotateSubscriptionSecret,
  updateSubscription,
  type WebhookDeliveryRecord,
  type WebhookRequest,
  type WebhookSubscriptionCreated,
  type WebhookSubscriptionRecord,
} from './webhooks.ts';

@Controller('webhooks')
export class WebhooksController {
  /** `POST /v1/webhooks/subscriptions` — registers one subscription; the secret is returned only here. */
  @Post('subscriptions')
  create(@Req() req: WebhookRequest, @Body() body: unknown): Promise<WebhookSubscriptionCreated> {
    return createSubscription(actorFromWebhookRequest(req), body);
  }

  /** `GET /v1/webhooks/subscriptions` — lists the tenant subscriptions, newest first. */
  @Get('subscriptions')
  subscriptions(@Req() req: WebhookRequest): Promise<WebhookSubscriptionRecord[]> {
    return listSubscriptions(actorFromWebhookRequest(req));
  }

  /** `PATCH /v1/webhooks/subscriptions/:id` — edits the URL, the event set or the active flag. */
  @Patch('subscriptions/:id')
  update(
    @Req() req: WebhookRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<WebhookSubscriptionRecord> {
    return updateSubscription(actorFromWebhookRequest(req), id, body);
  }

  /** `DELETE /v1/webhooks/subscriptions/:id` — removes one subscription; 409 when it has delivery history. */
  @Delete('subscriptions/:id')
  remove(@Req() req: WebhookRequest, @Param('id') id: string): Promise<WebhookSubscriptionRecord> {
    return removeSubscription(actorFromWebhookRequest(req), id);
  }

  /** `POST /v1/webhooks/subscriptions/:id/rotate` — replaces the signing secret (shown once). */
  @Post('subscriptions/:id/rotate')
  rotate(@Req() req: WebhookRequest, @Param('id') id: string): Promise<WebhookSubscriptionCreated> {
    return rotateSubscriptionSecret(actorFromWebhookRequest(req), id);
  }

  /** `GET /v1/webhooks/deliveries` — read-only retry observability, newest first. */
  @Get('deliveries')
  deliveries(
    @Req() req: WebhookRequest,
    @Query('subscriptionId') subscriptionId?: string,
    @Query('status') status?: string,
    @Query('event') event?: string,
  ): Promise<WebhookDeliveryRecord[]> {
    return listDeliveries(actorFromWebhookRequest(req), { subscriptionId, status, event });
  }

  /** `GET /v1/webhooks/deliveries/:id` — one delivery with its retry state. */
  @Get('deliveries/:id')
  delivery(@Req() req: WebhookRequest, @Param('id') id: string): Promise<WebhookDeliveryRecord> {
    return getDelivery(actorFromWebhookRequest(req), id);
  }
}
