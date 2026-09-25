// Webhook delivery coverage (W2): HMAC signing round-trip, tamper and replay
// rejection, outcome mapping over the existing `WEBHOOK=[60,300,1800,7200,21600]`
// backoff, and the transport boundary of one delivery attempt.
//
// Everything here is pure or seam-injected (fake transport, fixed clock): no
// Redis, no BullMQ connection, no network. All identifiers are synthetic.
// Runner: `node --test src/webhook-deliver.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WEBHOOK_RETRY_DELAYS_SECONDS,
  nextRetryDelay,
} from './queues.ts';
import {
  SIGNATURE_PREFIX,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  buildWebhookHeaders,
  signWebhookMessage,
  verifyWebhookSignature,
} from './webhook-signer.ts';
import {
  CLAIM_DUE_DELIVERIES_SQL,
  UPDATE_DELIVERY_SQL,
  buildDeliveryOutcome,
  isDeliverySuccess,
  persistDeliveryOutcome,
  processWebhookDelivery,
  webhookMaxAttempts,
  type WebhookDeliveryJob,
  type WebhookTransport,
} from './webhook-deliver.ts';

const SECRET = 'whsec_test_secret_for_signing_only';
const BODY = JSON.stringify({ invoiceId: 'e1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d', total: 118 });
const NOW_SECONDS = 1_788_000_000;
const NOW_MS = NOW_SECONDS * 1000;

function job(overrides: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return {
    deliveryId: 'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    tenantId: '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b',
    subscriptionId: 'd1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    url: 'https://ops.example.com/hooks/rizoma',
    event: 'invoice.issued',
    payload: BODY,
    attempts: 0,
    secret: SECRET,
    ...overrides,
  };
}

function okTransport(status = 200): WebhookTransport & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async post(url: string, body: string, headers: Record<string, string>) {
      calls.push({ url, body, headers });
      return { ok: status >= 200 && status < 300, status };
    },
  };
}

// ============ signing ============

describe('webhook signing', () => {
  it('signs deterministically and verifies the round trip', () => {
    const timestamp = String(NOW_SECONDS);
    const first = signWebhookMessage(SECRET, timestamp, BODY);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(first, signWebhookMessage(SECRET, timestamp, BODY));

    const headers = buildWebhookHeaders({
      secret: SECRET,
      event: 'invoice.issued',
      deliveryId: 'delivery-1',
      body: BODY,
      timestamp,
    });
    assert.ok(headers.signature.startsWith(SIGNATURE_PREFIX));
    assert.equal(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestamp: headers.timestamp,
        signature: headers.signature,
        nowSeconds: NOW_SECONDS,
      }),
      true,
    );
  });

  it('rejects a tampered body, a wrong secret and a replayed timestamp', () => {
    const timestamp = String(NOW_SECONDS);
    const headers = buildWebhookHeaders({
      secret: SECRET,
      event: 'invoice.issued',
      deliveryId: 'delivery-1',
      body: BODY,
      timestamp,
    });
    const verify = (overrides: Record<string, string>) =>
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestamp: headers.timestamp,
        signature: headers.signature,
        nowSeconds: NOW_SECONDS,
        ...overrides,
      });

    assert.equal(verify({ body: `${BODY} ` }), false, 'tampered bytes fail');
    assert.equal(verify({ secret: 'whsec_wrong' }), false, 'wrong secret fails');
    assert.equal(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestamp: String(NOW_SECONDS - 3600),
        signature: buildWebhookHeaders({
          secret: SECRET,
          event: 'invoice.issued',
          deliveryId: 'delivery-1',
          body: BODY,
          timestamp: String(NOW_SECONDS - 3600),
        }).signature,
        nowSeconds: NOW_SECONDS,
      }),
      false,
      'a one-hour-old signature is a replay',
    );
  });

  it('rejects malformed headers without throwing', () => {
    for (const signature of ['', 'sha256=', 'md5=abcd', 'sha256=zzzz', '  ']) {
      assert.equal(
        verifyWebhookSignature({ secret: SECRET, body: BODY, timestamp: String(NOW_SECONDS), signature, nowSeconds: NOW_SECONDS }),
        false,
      );
    }
    assert.equal(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY,
        timestamp: 'not-a-number',
        signature: `${SIGNATURE_PREFIX}${'a'.repeat(64)}`,
        nowSeconds: NOW_SECONDS,
      }),
      false,
    );
    assert.equal(
      verifyWebhookSignature({ secret: '', body: BODY, timestamp: String(NOW_SECONDS), signature: `${SIGNATURE_PREFIX}${'a'.repeat(64)}`, nowSeconds: NOW_SECONDS }),
      false,
    );
  });
});

// ============ outcome mapping ============

describe('delivery outcomes', () => {
  it('treats any 2xx as success', () => {
    assert.equal(isDeliverySuccess(200), true);
    assert.equal(isDeliverySuccess(204), true);
    assert.equal(isDeliverySuccess(301), false);
    assert.equal(isDeliverySuccess(500), false);
  });

  it('marks success sent with no retry scheduled', () => {
    const outcome = buildDeliveryOutcome({ ok: true, attempt: 1, nowMs: NOW_MS });
    assert.deepEqual(outcome, {
      status: 'sent',
      attempts: 1,
      retryDelaySeconds: null,
      nextRetryAt: null,
      lastError: null,
    });
  });

  it('walks the existing WEBHOOK backoff while attempts remain', () => {
    assert.deepEqual([...WEBHOOK_RETRY_DELAYS_SECONDS], [60, 300, 1800, 7200, 21600]);
    assert.equal(webhookMaxAttempts(), WEBHOOK_RETRY_DELAYS_SECONDS.length);

    const first = buildDeliveryOutcome({ ok: false, status: 500, attempt: 1, nowMs: NOW_MS });
    assert.equal(first.status, 'queued');
    assert.equal(first.retryDelaySeconds, 60);
    assert.equal(first.nextRetryAt, new Date(NOW_MS + 60_000).toISOString());
    assert.equal(first.attempts, 1);

    const fourth = buildDeliveryOutcome({ ok: false, status: 500, attempt: 4, nowMs: NOW_MS });
    assert.equal(fourth.retryDelaySeconds, 7200);
    assert.equal(nextRetryDelay('webhook-deliver', 4), 7200, 'the worker reuses the queue helper');
  });

  it('fails the delivery once the backoff is exhausted', () => {
    const exhausted = buildDeliveryOutcome({ ok: false, status: 503, attempt: 5, nowMs: NOW_MS });
    assert.equal(exhausted.status, 'queued', 'attempt 5 still has its last delay');
    assert.equal(exhausted.retryDelaySeconds, 21600);

    const beyond = buildDeliveryOutcome({ ok: false, status: 503, attempt: 6, nowMs: NOW_MS });
    assert.equal(beyond.status, 'failed');
    assert.equal(beyond.nextRetryAt, null);
    assert.match(beyond.lastError ?? '', /503/);
  });
});

// ============ one attempt ============

describe('processWebhookDelivery', () => {
  it('POSTs the exact payload bytes with the four signed headers', async () => {
    const transport = okTransport(200);
    const { outcome } = await processWebhookDelivery(job(), transport, NOW_MS);

    assert.equal(outcome.status, 'sent');
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0] as { url: string; body: string; headers: Record<string, string> };
    assert.equal(call.url, 'https://ops.example.com/hooks/rizoma');
    assert.equal(call.body, BODY, 'the signature covers these exact bytes');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.ok(call.headers[WEBHOOK_SIGNATURE_HEADER].startsWith(SIGNATURE_PREFIX));
    assert.equal(call.headers[WEBHOOK_EVENT_HEADER], 'invoice.issued');
    assert.equal(call.headers[WEBHOOK_DELIVERY_HEADER], 'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
    assert.equal(
      verifyWebhookSignature({
        secret: SECRET,
        body: call.body,
        timestamp: call.headers[WEBHOOK_TIMESTAMP_HEADER],
        signature: call.headers[WEBHOOK_SIGNATURE_HEADER],
        nowSeconds: NOW_SECONDS,
      }),
      true,
      'what the worker sends is what the receiver can verify',
    );
  });

  it('reschedules on a 500 with the backoff for the next attempt', async () => {
    const transport = okTransport(500);
    const { outcome } = await processWebhookDelivery(job({ attempts: 2 }), transport, NOW_MS);
    assert.equal(outcome.status, 'queued');
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.retryDelaySeconds, 1800);
    assert.equal(outcome.nextRetryAt, new Date(NOW_MS + 1_800_000).toISOString());
  });

  it('maps a transport error to a queued outcome without throwing', async () => {
    const transport: WebhookTransport = {
      async post() {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const { outcome } = await processWebhookDelivery(job(), transport, NOW_MS);
    assert.equal(outcome.status, 'queued');
    assert.match(outcome.lastError ?? '', /ECONNREFUSED/);
  });

  it('persists the outcome to the delivery row the relay claimed', async () => {
    const seen: Array<{ text: string; values: readonly unknown[] }> = [];
    await persistDeliveryOutcome(
      {
        async query(text: string, values?: readonly unknown[]) {
          seen.push({ text, values: values ?? [] });
          return { rows: [] };
        },
      },
      job(),
      buildDeliveryOutcome({ ok: true, attempt: 1, nowMs: NOW_MS }),
    );
    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.text.includes('UPDATE webhook_deliveries'));
    assert.deepEqual(seen[0]?.values.slice(0, 3), [
      'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      'sent',
      1,
    ]);
  });

  it('exposes the relay claim and outcome SQL the runtime depends on', () => {
    assert.ok(UPDATE_DELIVERY_SQL.includes('UPDATE webhook_deliveries'));
    assert.ok(CLAIM_DUE_DELIVERIES_SQL.includes('FOR UPDATE SKIP LOCKED'));
    assert.ok(CLAIM_DUE_DELIVERIES_SQL.includes("status = 'queued'"));
  });
});
