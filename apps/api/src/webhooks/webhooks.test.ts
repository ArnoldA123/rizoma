// Webhook coverage (W2): digest-only secret handling, tenant-admin gate,
// management use cases, read-only delivery observability and the outbox writer.
//
// The SQL client is a small stateful in-memory double: it implements the exact
// statements `webhooks/webhooks.ts` issues over synthetic rows, so the suite
// exercises the real control flow (guard, hashing, fan-out) without Postgres.
// All data is synthetic.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  WEBHOOK_BILLING_EVENTS,
  WEBHOOK_EVENTS,
  WEBHOOK_ONBOARDING_EVENTS,
  WEBHOOK_STOCK_EVENTS,
  createSubscription,
  enqueueInvoiceWebhooks,
  enqueueOnboardingClosed,
  enqueueWebhooks,
  generateWebhookSecret,
  getDelivery,
  hashWebhookSecret,
  isWebhookAdminRole,
  listDeliveries,
  listSubscriptions,
  parseDeliveryFilters,
  parseSubscriptionCreateInput,
  parseSubscriptionUpdateInput,
  removeSubscription,
  rotateSubscriptionSecret,
  updateSubscription,
  type WebhookActor,
  type WebhookClient,
} from './webhooks.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const ADMIN_USER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PLAIN_USER_ID = 'b1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ORG_NODE_ID = 'c1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SUBSCRIPTION_ID = 'd1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const INVOICE_ID = 'e1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const TRACE = 'trace-webhooks-1';

// ============ in-memory double ============

interface FakeDb {
  /** Membership row answered to the guard lookup (`null` = no membership). */
  membership: Record<string, unknown> | null;
  /** Rows answered to the subscription list. */
  subscriptions: Record<string, unknown>[];
  /** Rows answered to the delivery list / single delivery read. */
  deliveries: Record<string, unknown>[];
  /** Active subscriptions the outbox writer fans out to. */
  targets: Record<string, unknown>[];
  /** `false` simulates a missing row on update/delete/rotate (unknown id). */
  rowFound: boolean;
  /** `true` simulates a FK violation on delete (delivery history exists). */
  deleteBlocked: boolean;
  queries: Array<{ text: string; values: readonly unknown[] }>;
  auditActions: unknown[];
}

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: 'f1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    user_id: ADMIN_USER_ID,
    tenant_id: TENANT_ID,
    org_node_id: ORG_NODE_ID,
    role,
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

function subscriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SUBSCRIPTION_ID,
    tenant_id: TENANT_ID,
    url: 'https://ops.example.com/hooks/rizoma',
    events: ['invoice.issued', 'invoice.paid'],
    active: true,
    created_at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function deliveryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    tenant_id: TENANT_ID,
    subscription_id: SUBSCRIPTION_ID,
    event: 'invoice.issued',
    url: 'https://ops.example.com/hooks/rizoma',
    status: 'queued',
    attempts: 0,
    next_retry_at: null,
    created_at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function createFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    membership: membershipRow('ti_admin'),
    subscriptions: [subscriptionRow()],
    deliveries: [deliveryRow()],
    targets: [{ id: SUBSCRIPTION_ID, url: 'https://ops.example.com/hooks/rizoma' }],
    rowFound: true,
    deleteBlocked: false,
    queries: [],
    auditActions: [],
    ...overrides,
  };
}

/** Dispatches on the statement markers the service emits. */
function createFakeClient(db: FakeDb): WebhookClient {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      db.queries.push({ text, values });
      if (text.includes('FROM memberships m')) {
        return { rows: db.membership === null ? [] : [db.membership] };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: [{ id: ORG_NODE_ID }] };
      }
      if (text.includes('INSERT INTO webhook_subscriptions')) {
        return {
          rows: [
            {
              id: 'b2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              tenant_id: values[0],
              url: values[1],
              secret_hash: values[2],
              events: values[3],
              active: true,
              created_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (text.includes('ANY(events)')) {
        return { rows: db.targets };
      }
      if (text.includes('FROM webhook_subscriptions WHERE')) {
        return { rows: db.subscriptions };
      }
      if (text.includes('UPDATE webhook_subscriptions')) {
        if (!db.rowFound) return { rows: [] };
        const current = subscriptionRow();
        if (text.includes('SET secret_hash')) return { rows: [current] };
        return {
          rows: [
            {
              ...current,
              url: values[2] ?? current.url,
              events: values[3] ?? current.events,
              active: values[4] ?? current.active,
            },
          ],
        };
      }
      if (text.includes('DELETE FROM webhook_subscriptions')) {
        if (db.deleteBlocked) {
          throw Object.assign(new Error('violates foreign key'), { code: '23503' });
        }
        return { rows: db.rowFound ? [subscriptionRow()] : [] };
      }
      if (text.includes('INSERT INTO webhook_deliveries')) {
        return {
          rows: [
            {
              id: 'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              tenant_id: values[0],
              subscription_id: values[1],
              event: values[4],
              url: values[3],
              status: 'queued',
              attempts: 0,
              next_retry_at: null,
              created_at: new Date().toISOString(),
            },
          ],
        };
      }
      if (text.includes('FROM webhook_deliveries WHERE tenant_id = $1 AND id = $2')) {
        return { rows: db.deliveries.slice(0, 1) };
      }
      if (text.includes('FROM webhook_deliveries WHERE')) {
        return { rows: db.deliveries };
      }
      if (text.includes('INSERT INTO audit_log')) {
        db.auditActions.push(values[2]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function actorFor(db: FakeDb, userId: string = ADMIN_USER_ID): WebhookActor {
  return { client: createFakeClient(db), tenantId: TENANT_ID, userId, traceId: TRACE, ip: null };
}

function statusOf(error: unknown): number {
  assert.ok(error instanceof HttpException);
  return error.getStatus();
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof HttpException);
  return (error.getResponse() as { code: string }).code;
}

// ============ secret handling ============

describe('webhook secrets', () => {
  it('hashes deterministically to 64 hex chars without the secret', () => {
    const first = hashWebhookSecret('whsec_opaque');
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, hashWebhookSecret('whsec_opaque'));
    assert.ok(!first.includes('whsec_opaque'));
    assert.notEqual(first, hashWebhookSecret('whsec_other'));
  });

  it('generates unique prefixed secrets whose digest verifies', () => {
    const first = generateWebhookSecret();
    const second = generateWebhookSecret();
    assert.ok(first.secret.startsWith('whsec_'));
    assert.equal(first.secretHash, hashWebhookSecret(first.secret));
    assert.notEqual(first.secret, second.secret);
  });

  it('recognizes the tenant admin roles only', () => {
    assert.equal(isWebhookAdminRole('ti_admin'), true);
    assert.equal(isWebhookAdminRole('direccion'), true);
    assert.equal(isWebhookAdminRole('medico'), false);
    assert.equal(isWebhookAdminRole('caja'), false);
  });

  it('exposes the billing event trio first', () => {
    assert.deepEqual([...WEBHOOK_BILLING_EVENTS], ['invoice.issued', 'invoice.paid', 'invoice.voided']);
  });
});

// ============ input validation ============

describe('parseSubscriptionCreateInput', () => {
  it('accepts an https URL with deduplicated events', () => {
    const parsed = parseSubscriptionCreateInput(
      { url: 'https://ops.example.com/h', events: ['invoice.issued', 'invoice.issued'] },
      TRACE,
    );
    assert.deepEqual(parsed.events, ['invoice.issued']);
  });

  it('rejects a non-object body, a bad URL and bad events', () => {
    for (const body of [null, 'x', [], {}, { url: '', events: [] }]) {
      assert.equal(codeOf(catchSync(() => parseSubscriptionCreateInput(body, TRACE))), 'validation.failed');
    }
    assert.equal(
      codeOf(
        catchSync(() =>
          parseSubscriptionCreateInput({ url: 'notaurl', events: ['invoice.issued'] }, TRACE),
        ),
      ),
      'validation.failed',
    );
    assert.equal(
      codeOf(
        catchSync(() =>
          parseSubscriptionCreateInput({ url: 'ftp://ops.example.com/h', events: ['invoice.issued'] }, TRACE),
        ),
      ),
      'validation.failed',
    );
    assert.equal(
      codeOf(
        catchSync(() =>
          parseSubscriptionCreateInput({ url: 'https://ops.example.com/h', events: ['stock.moved'] }, TRACE),
        ),
      ),
      'validation.failed',
    );
    assert.equal(
      codeOf(
        catchSync(() => parseSubscriptionCreateInput({ url: 'https://ops.example.com/h', events: [] }, TRACE)),
      ),
      'validation.failed',
    );
  });
});

describe('parseSubscriptionUpdateInput', () => {
  it('accepts a partial body and requires at least one field', () => {
    assert.deepEqual(parseSubscriptionUpdateInput({ active: false }, TRACE), {
      url: undefined,
      events: undefined,
      active: false,
    });
    assert.equal(codeOf(catchSync(() => parseSubscriptionUpdateInput({}, TRACE))), 'validation.failed');
    assert.equal(
      codeOf(catchSync(() => parseSubscriptionUpdateInput({ active: 'yes' }, TRACE))),
      'validation.failed',
    );
  });
});

describe('parseDeliveryFilters', () => {
  it('defaults every filter to null and accepts the known trio', () => {
    assert.deepEqual(parseDeliveryFilters({}, TRACE), {
      subscriptionId: null,
      status: null,
      event: null,
    });
    assert.deepEqual(
      parseDeliveryFilters({ subscriptionId: SUBSCRIPTION_ID, status: 'failed', event: 'invoice.paid' }, TRACE),
      { subscriptionId: SUBSCRIPTION_ID, status: 'failed', event: 'invoice.paid' },
    );
  });

  it('rejects a malformed subscription, an unknown status and an unknown event', () => {
    assert.equal(
      codeOf(catchSync(() => parseDeliveryFilters({ subscriptionId: 'x' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(catchSync(() => parseDeliveryFilters({ status: 'pending' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(catchSync(() => parseDeliveryFilters({ event: 'stock.moved' }, TRACE))),
      'validation.failed',
    );
  });
});

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

// ============ management use cases ============

describe('createSubscription', () => {
  it('registers one subscription and returns the secret exactly once', async () => {
    const db = createFakeDb();
    const created = await createSubscription(actorFor(db), {
      url: 'https://ops.example.com/h',
      events: ['invoice.issued'],
    });

    assert.ok(created.secret.startsWith('whsec_'));
    assert.equal(created.url, 'https://ops.example.com/h');
    assert.equal(created.active, true);
    assert.ok(!Object.hasOwn(created, 'secret_hash'));
    const insert = db.queries.find((entry) => entry.text.includes('INSERT INTO webhook_subscriptions'));
    assert.ok(insert !== undefined, 'the subscription row is inserted');
    // Digest-only storage: the stored hash verifies the returned secret, and
    // the clear secret is nowhere in the bound values.
    assert.equal(insert.values[2], hashWebhookSecret(created.secret));
    for (const value of insert.values) {
      assert.ok(value !== created.secret, 'the clear secret is never bound to SQL');
    }
    assert.ok(db.auditActions.includes('webhook_subscription.created'));
  });

  it('denies a non-admin role with access.denied and inserts nothing', async () => {
    const db = createFakeDb({ membership: membershipRow('medico') });
    const error = await createSubscription(actorFor(db), {
      url: 'https://ops.example.com/h',
      events: ['invoice.issued'],
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 403);
    assert.equal(codeOf(error), 'access.denied');
    assert.equal(
      db.queries.some((entry) => entry.text.includes('INSERT INTO webhook_subscriptions')),
      false,
    );
    assert.ok(db.auditActions.includes('access.denied'), 'the denial is audited');
  });

  it('answers 400 on a bad body before touching the database', async () => {
    const db = createFakeDb();
    const error = await createSubscription(actorFor(db), { url: 'x', events: [] }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 400);
    assert.equal(db.queries.length, 0, 'no query runs on a validation failure');
  });
});

describe('listSubscriptions', () => {
  it('lists rows without secrets or hashes for an admin', async () => {
    const db = createFakeDb();
    const rows = await listSubscriptions(actorFor(db));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.url, 'https://ops.example.com/hooks/rizoma');
    assert.ok(!Object.hasOwn(rows[0] as object, 'secret'));
    assert.ok(!Object.hasOwn(rows[0] as object, 'secret_hash'));
  });

  it('denies an API-key caller without membership', async () => {
    const db = createFakeDb({ membership: null });
    const error = await listSubscriptions(actorFor(db, SUBSCRIPTION_ID)).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(error), 'access.denied');
  });
});

describe('updateSubscription', () => {
  it('edits the URL and audits the change', async () => {
    const db = createFakeDb();
    const updated = await updateSubscription(actorFor(db), SUBSCRIPTION_ID, {
      url: 'https://ops.example.com/hooks/v2',
    });
    assert.equal(updated.url, 'https://ops.example.com/hooks/v2');
    assert.ok(db.auditActions.includes('webhook_subscription.updated'));
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const missing = await updateSubscription(actorFor(createFakeDb({ rowFound: false })), SUBSCRIPTION_ID, {
      active: false,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(missing), 404);

    const malformed = await updateSubscription(actorFor(createFakeDb()), 'not-a-uuid', {
      active: false,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(malformed), 400);
  });
});

describe('removeSubscription', () => {
  it('removes a subscription without history and audits', async () => {
    const db = createFakeDb();
    const removed = await removeSubscription(actorFor(db), SUBSCRIPTION_ID);
    assert.equal(removed.id, SUBSCRIPTION_ID);
    assert.ok(db.auditActions.includes('webhook_subscription.removed'));
  });

  it('answers 409 when delivery history blocks the delete', async () => {
    const db = createFakeDb({ deleteBlocked: true });
    const error = await removeSubscription(actorFor(db), SUBSCRIPTION_ID).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 409);
    assert.equal(codeOf(error), 'webhook.subscription_in_use');
  });

  it('answers 404 for an unknown id', async () => {
    const error = await removeSubscription(actorFor(createFakeDb({ rowFound: false })), SUBSCRIPTION_ID).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 404);
  });
});

describe('rotateSubscriptionSecret', () => {
  it('replaces the digest and returns the new secret exactly once', async () => {
    const db = createFakeDb();
    const rotated = await rotateSubscriptionSecret(actorFor(db), SUBSCRIPTION_ID);
    assert.ok(rotated.secret.startsWith('whsec_'));
    const update = db.queries.find((entry) => entry.text.includes('SET secret_hash'));
    assert.ok(update !== undefined, 'the digest is replaced');
    assert.equal(update.values[2], hashWebhookSecret(rotated.secret));
    assert.ok(db.auditActions.includes('webhook_subscription.rotated'));
  });

  it('answers 404 for an unknown id', async () => {
    const error = await rotateSubscriptionSecret(
      actorFor(createFakeDb({ rowFound: false })),
      SUBSCRIPTION_ID,
    ).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 404);
  });
});

// ============ read-only deliveries ============

describe('listDeliveries', () => {
  it('returns the retry state without writing audit rows', async () => {
    const db = createFakeDb();
    const rows = await listDeliveries(actorFor(db), { status: 'queued' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'queued');
    assert.equal(rows[0]?.attempts, 0);
    assert.equal(rows[0]?.nextRetryAt, null);
    assert.equal(
      db.queries.filter((entry) => entry.text.includes('INSERT INTO audit_log')).length,
      0,
      'reads write no audit row',
    );
  });

  it('denies a non-admin role', async () => {
    const db = createFakeDb({ membership: membershipRow('caja') });
    const error = await listDeliveries(actorFor(db), {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(error), 'access.denied');
  });
});

describe('getDelivery', () => {
  it('returns one delivery for an admin', async () => {
    const db = createFakeDb();
    const delivery = await getDelivery(actorFor(db), 'a2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
    assert.equal(delivery.event, 'invoice.issued');
  });

  it('answers 404 when the tenant has no such delivery', async () => {
    const db = createFakeDb({ deliveries: [] });
    const error = await getDelivery(actorFor(db), 'a2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d').then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 404);
  });
});

// ============ outbox writer ============

describe('enqueueInvoiceWebhooks', () => {
  it('fans one queued delivery per matching subscription in the same tx', async () => {
    const db = createFakeDb();
    const client = createFakeClient(db);
    const deliveries = await enqueueInvoiceWebhooks(client, TENANT_ID, {
      event: 'invoice.issued',
      invoiceId: INVOICE_ID,
      payload: { invoiceId: INVOICE_ID, total: 118 },
    });

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, 'queued');
    assert.equal(deliveries[0]?.attempts, 0);
    assert.equal(deliveries[0]?.event, 'invoice.issued');
    assert.equal(deliveries[0]?.url, 'https://ops.example.com/hooks/rizoma');
    const insert = db.queries.find((entry) => entry.text.includes('INSERT INTO webhook_deliveries'));
    assert.ok(insert !== undefined, 'the delivery row is inserted');
    assert.deepEqual(insert.values.slice(0, 5), [
      TENANT_ID,
      SUBSCRIPTION_ID,
      INVOICE_ID,
      'https://ops.example.com/hooks/rizoma',
      'invoice.issued',
    ]);
    assert.ok(
      db.queries.every((entry) => !entry.text.includes('BEGIN') && !entry.text.includes('COMMIT')),
      'the writer never opens its own transaction: it joins the business tx',
    );
  });

  it('enqueues nothing when no subscription matches, without failing the business write', async () => {
    const db = createFakeDb({ targets: [] });
    const deliveries = await enqueueInvoiceWebhooks(createFakeClient(db), TENANT_ID, {
      event: 'invoice.voided',
      invoiceId: INVOICE_ID,
      payload: { invoiceId: INVOICE_ID },
    });
    assert.deepEqual(deliveries, []);
  });

  it('enqueues nothing for a malformed tenant or invoice id', async () => {
    const db = createFakeDb();
    const client = createFakeClient(db);
    assert.deepEqual(
      await enqueueInvoiceWebhooks(client, 'not-a-uuid', {
        event: 'invoice.issued',
        invoiceId: INVOICE_ID,
        payload: {},
      }),
      [],
    );
    assert.deepEqual(
      await enqueueInvoiceWebhooks(client, TENANT_ID, {
        event: 'invoice.issued',
        invoiceId: 'x',
        payload: {},
      }),
      [],
    );
  });
});

// ============ W3 events + generic writer ============

describe('webhook event sets', () => {
  it('exposes billing, stock and onboarding trios under one union', () => {
    assert.deepEqual([...WEBHOOK_BILLING_EVENTS], ['invoice.issued', 'invoice.paid', 'invoice.voided']);
    assert.deepEqual([...WEBHOOK_STOCK_EVENTS], ['stock.posted', 'stock.reversed']);
    assert.deepEqual([...WEBHOOK_ONBOARDING_EVENTS], ['onboarding.closed']);
    assert.deepEqual([...WEBHOOK_EVENTS], [
      'invoice.issued',
      'invoice.paid',
      'invoice.voided',
      'stock.posted',
      'stock.reversed',
      'onboarding.closed',
    ]);
  });

  it('accepts the W3 events on subscriptions and delivery filters', () => {
    const created = parseSubscriptionCreateInput(
      { url: 'https://ops.example.com/h', events: ['stock.posted', 'stock.reversed', 'onboarding.closed'] },
      TRACE,
    );
    assert.deepEqual(created.events, ['stock.posted', 'stock.reversed', 'onboarding.closed']);
    assert.deepEqual(parseDeliveryFilters({ event: 'stock.posted' }, TRACE), {
      subscriptionId: null,
      status: null,
      event: 'stock.posted',
    });
    assert.deepEqual(parseDeliveryFilters({ event: 'onboarding.closed' }, TRACE), {
      subscriptionId: null,
      status: null,
      event: 'onboarding.closed',
    });
    assert.equal(
      codeOf(catchSync(() => parseDeliveryFilters({ event: 'stock.moved' }, TRACE))),
      'validation.failed',
    );
  });
});

describe('enqueueWebhooks', () => {
  it('fans a stock.posted fact out in the emitter transaction', async () => {
    const db = createFakeDb();
    const client = createFakeClient(db);
    const moveId = 'f3000000-0000-4000-8000-000000000022';
    const deliveries = await enqueueWebhooks(client, TENANT_ID, {
      event: 'stock.posted',
      eventId: moveId,
      payload: { moveId, qty: 10, kind: 'in', status: 'posted' },
    });

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, 'queued');
    assert.equal(deliveries[0]?.event, 'stock.posted');
    const insert = db.queries.find((entry) => entry.text.includes('INSERT INTO webhook_deliveries'));
    assert.ok(insert !== undefined, 'the delivery row is inserted');
    assert.deepEqual(insert.values.slice(0, 5), [
      TENANT_ID,
      SUBSCRIPTION_ID,
      moveId,
      'https://ops.example.com/hooks/rizoma',
      'stock.posted',
    ]);
    assert.ok(
      db.queries.every((entry) => !entry.text.includes('BEGIN') && !entry.text.includes('COMMIT')),
      'the writer never opens its own transaction: it joins the business tx',
    );
  });

  it('enqueues nothing for an event outside the union', async () => {
    const db = createFakeDb();
    const deliveries = await enqueueWebhooks(createFakeClient(db), TENANT_ID, {
      event: 'stock.moved' as never,
      eventId: INVOICE_ID,
      payload: {},
    });
    assert.deepEqual(deliveries, []);
  });
});

describe('enqueueOnboardingClosed', () => {
  it('fans onboarding.closed with the closed-case facts', async () => {
    const db = createFakeDb();
    const caseId = 'c3000000-0000-4000-8000-000000000033';
    const deliveries = await enqueueOnboardingClosed(createFakeClient(db), TENANT_ID, {
      caseId,
      idempotencyKey: 'wizard-run-1',
      actaHash: '0'.repeat(64),
    });

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.event, 'onboarding.closed');
    const insert = db.queries.find((entry) => entry.text.includes('INSERT INTO webhook_deliveries'));
    assert.ok(insert !== undefined, 'the delivery row is inserted');
    assert.deepEqual(insert.values.slice(0, 5), [
      TENANT_ID,
      SUBSCRIPTION_ID,
      caseId,
      'https://ops.example.com/hooks/rizoma',
      'onboarding.closed',
    ]);
    assert.equal(
      JSON.parse(String(insert.values[5])).caseId,
      caseId,
      'the payload carries the closed-case facts the worker signs',
    );
  });

  it('enqueues nothing for a malformed case id', async () => {
    const db = createFakeDb();
    assert.deepEqual(
      await enqueueOnboardingClosed(createFakeClient(db), TENANT_ID, {
        caseId: 'x',
        idempotencyKey: 'wizard-run-1',
        actaHash: '0'.repeat(64),
      }),
      [],
    );
  });
});
