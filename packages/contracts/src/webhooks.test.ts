// Webhook contract tests — synthetic payloads only, no live API involved.
//
// They protect the W2 security property at the contract layer: the signing
// secret is returned exactly once (create/rotate response) and every other
// shape rejects it, events stay within the emitted set, and deliveries expose
// the retry state (`attempts`, `nextRetryAt`) the worker updates.
// Runner: `node --test src/webhooks.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookDeliveryListSchema,
  webhookDeliveryRecordSchema,
  webhookEventSchema,
  webhookSubscriptionCreateInputSchema,
  webhookSubscriptionCreateResponseSchema,
  webhookSubscriptionListSchema,
  webhookSubscriptionRecordSchema,
  webhookSubscriptionUpdateInputSchema,
} from './webhooks.ts';

/** Synthetic tenant/subscription identifiers — demo data, never production values. */
const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION = '22222222-2222-4222-8222-222222222222';
const DELIVERY = '33333333-3333-4333-8333-333333333333';

function subscriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUBSCRIPTION,
    tenantId: TENANT,
    url: 'https://ops.example.com/hooks/rizoma',
    events: ['invoice.issued', 'invoice.paid'],
    active: true,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function deliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DELIVERY,
    tenantId: TENANT,
    subscriptionId: SUBSCRIPTION,
    event: 'invoice.issued',
    url: 'https://ops.example.com/hooks/rizoma',
    status: 'queued',
    attempts: 2,
    nextRetryAt: '2026-09-25T10:30:00.000Z',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

test('signature headers are stable lowercase names with a prefixed secret', () => {
  assert.equal(WEBHOOK_SIGNATURE_HEADER, 'x-webhook-signature');
  assert.equal(WEBHOOK_TIMESTAMP_HEADER, 'x-webhook-timestamp');
  assert.equal(WEBHOOK_EVENT_HEADER, 'x-webhook-event');
  assert.equal(WEBHOOK_DELIVERY_HEADER, 'x-webhook-delivery');
  assert.equal(WEBHOOK_SECRET_PREFIX, 'whsec_');
});

test('event schema accepts the billing trio and rejects anything else', () => {
  assert.equal(webhookEventSchema.parse('invoice.issued'), 'invoice.issued');
  assert.equal(webhookEventSchema.parse('invoice.paid'), 'invoice.paid');
  assert.equal(webhookEventSchema.parse('invoice.voided'), 'invoice.voided');
  assert.throws(() => webhookEventSchema.parse('invoice.drafted'));
  assert.throws(() => webhookEventSchema.parse('stock.moved'));
  assert.throws(() => webhookEventSchema.parse(''));
});

test('event schema accepts the W3 stock and onboarding events', () => {
  assert.equal(webhookEventSchema.parse('stock.posted'), 'stock.posted');
  assert.equal(webhookEventSchema.parse('stock.reversed'), 'stock.reversed');
  assert.equal(webhookEventSchema.parse('onboarding.closed'), 'onboarding.closed');
  assert.throws(() => webhookEventSchema.parse('stock.post'));
  assert.throws(() => webhookEventSchema.parse('onboarding.opened'));
});

test('create body accepts a URL with deduplicated events', () => {
  const parsed = webhookSubscriptionCreateInputSchema.parse({
    url: 'https://ops.example.com/hooks/rizoma',
    events: ['invoice.issued', 'invoice.voided'],
  });
  assert.deepEqual(parsed.events, ['invoice.issued', 'invoice.voided']);
});

test('create body rejects a non-URL, an empty event set and duplicates', () => {
  assert.throws(() =>
    webhookSubscriptionCreateInputSchema.parse({ url: 'not-a-url', events: ['invoice.issued'] }),
  );
  assert.throws(() =>
    webhookSubscriptionCreateInputSchema.parse({ url: 'https://ops.example.com/h', events: [] }),
  );
  assert.throws(() =>
    webhookSubscriptionCreateInputSchema.parse({
      url: 'https://ops.example.com/h',
      events: ['invoice.issued', 'invoice.issued'],
    }),
  );
  assert.throws(() =>
    webhookSubscriptionCreateInputSchema.parse({
      url: 'https://ops.example.com/h',
      events: ['invoice.drafted'],
    }),
  );
});

test('update body is fully optional but still validates each field', () => {
  assert.deepEqual(webhookSubscriptionUpdateInputSchema.parse({}), {});
  assert.deepEqual(webhookSubscriptionUpdateInputSchema.parse({ active: false }), { active: false });
  assert.throws(() => webhookSubscriptionUpdateInputSchema.parse({ url: 'notaurl' }));
  assert.throws(() => webhookSubscriptionUpdateInputSchema.parse({ events: [] }));
  assert.throws(() =>
    webhookSubscriptionUpdateInputSchema.parse({ events: ['invoice.paid', 'invoice.paid'] }),
  );
});

test('subscription record carries no secret and the list is an array of it', () => {
  const parsed = webhookSubscriptionRecordSchema.parse(subscriptionRow());
  assert.equal(parsed.id, SUBSCRIPTION);
  assert.ok(!Object.hasOwn(parsed, 'secret'), 'list shapes never carry the secret');
  assert.equal(
    webhookSubscriptionRecordSchema.strict().safeParse({ ...subscriptionRow(), secret: 'x' }).success,
    false,
    'a secret where none belongs fails validation',
  );
  assert.equal(webhookSubscriptionListSchema.parse([subscriptionRow()]).length, 1);
});

test('create response extends the record with the once-only secret', () => {
  const parsed = webhookSubscriptionCreateResponseSchema.parse({
    ...subscriptionRow(),
    secret: `${WEBHOOK_SECRET_PREFIX}opaque`,
  });
  assert.ok(parsed.secret.startsWith(WEBHOOK_SECRET_PREFIX));
  assert.throws(() =>
    webhookSubscriptionCreateResponseSchema.parse(subscriptionRow()),
  );
});

test('delivery record exposes the observable retry state', () => {
  const queued = webhookDeliveryRecordSchema.parse(deliveryRow());
  assert.equal(queued.status, 'queued');
  assert.equal(queued.attempts, 2);
  assert.equal(queued.nextRetryAt, '2026-09-25T10:30:00.000Z');

  const sent = webhookDeliveryRecordSchema.parse({
    ...deliveryRow(),
    status: 'sent',
    attempts: 1,
    nextRetryAt: null,
  });
  assert.equal(sent.nextRetryAt, null);

  const orphan = webhookDeliveryRecordSchema.parse({
    ...deliveryRow(),
    subscriptionId: null,
    status: 'failed',
  });
  assert.equal(orphan.subscriptionId, null);

  assert.throws(() => webhookDeliveryRecordSchema.parse({ ...deliveryRow(), status: 'pending' }));
  assert.throws(() => webhookDeliveryRecordSchema.parse({ ...deliveryRow(), event: 'stock.moved' }));
  assert.equal(webhookDeliveryListSchema.parse([deliveryRow()]).length, 1);
});
