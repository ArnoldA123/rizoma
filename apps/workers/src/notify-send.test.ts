// Notify send coverage (N2): template rendering, outcome mapping over the
// existing `NOTIFY=[60,600,3600]` backoff, the adapter boundary of one send
// attempt, and the terminal-only persistence back to `message_log`.
//
// Everything here is pure or seam-injected (fake adapter, fake SQL client,
// fixed clock): no Redis, no BullMQ connection, no network. All identifiers
// are synthetic.
// Runner: `node --test src/notify-send.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOTIFY_RETRY_DELAYS_SECONDS,
  nextRetryDelay,
} from './queues.ts';
import {
  LogNotifyAdapter,
  type NotifyAdapter,
  type NotifySendResult,
} from './notify-adapter.ts';
import {
  CLAIM_DUE_NOTIFY_SQL,
  MARK_NOTIFY_FAILED_SQL,
  MARK_NOTIFY_SENT_SQL,
  SELECT_ACTIVE_NOTIFY_TEMPLATE_SQL,
  buildNotifySendOutcome,
  enqueueNotifyJob,
  notifyMaxAttempts,
  persistNotifyOutcome,
  processNotifySend,
  renderNotifyBody,
  type NotifyRuntimeClient,
  type NotifySendJob,
} from './notify-send.ts';

const NOW_MS = 1_788_000_000_000;
const TENANT = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const MESSAGE = 'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const TEMPLATE_BODY = 'Hello {{ name }}, invoice {{folio}} totals {{total}}.';

function job(overrides: Partial<NotifySendJob> = {}): NotifySendJob {
  return {
    messageId: MESSAGE,
    tenantId: TENANT,
    channel: 'email',
    template: 'invoice.ready',
    to: 'ops@example.com',
    payload: { name: 'Ada', folio: 'INT-2026-000001', total: 118 },
    attempts: 0,
    ...overrides,
  };
}

/** SQL client that serves one template body and records every query. */
function clientWithTemplate(body: string | null): NotifyRuntimeClient & {
  seen: Array<{ text: string; values: readonly unknown[] }>;
} {
  const seen: Array<{ text: string; values: readonly unknown[] }> = [];
  return {
    seen,
    async query(text: string, values?: readonly unknown[]) {
      seen.push({ text, values: values ?? [] });
      if (text.includes('FROM notify_templates')) {
        return body === null ? { rows: [] } : { rows: [{ body }] };
      }
      return { rows: [] };
    },
  };
}

function failingAdapter(error: string): NotifyAdapter {
  return {
    name: 'failing',
    async send(): Promise<NotifySendResult> {
      return { ok: false, providerRef: null, cost: 0, error };
    },
  };
}

// ============ rendering ============

describe('renderNotifyBody', () => {
  it('replaces slots and tolerates whitespace inside the braces', () => {
    assert.equal(
      renderNotifyBody(TEMPLATE_BODY, { name: 'Ada', folio: 'INT-2026-000001', total: 118 }),
      'Hello Ada, invoice INT-2026-000001 totals 118.',
    );
  });

  it('renders unknown or nullish variables as an empty string', () => {
    assert.equal(renderNotifyBody('Hi {{name}} ({{missing}}).', { name: 'Ada' }), 'Hi Ada ().');
    assert.equal(renderNotifyBody('Hi {{name}}.', { name: null }), 'Hi .');
  });

  it('resolves dotted paths into nested payloads', () => {
    assert.equal(
      renderNotifyBody('Total {{invoice.total}}.', { invoice: { total: 118 } }),
      'Total 118.',
    );
    assert.equal(renderNotifyBody('Total {{invoice.total}}.', {}), 'Total .');
  });
});

// ============ outcome mapping ============

describe('notify send outcomes', () => {
  it('marks success sent with the adapter cost and provider ref', () => {
    const outcome = buildNotifySendOutcome({
      ok: true,
      attempt: 1,
      cost: 0,
      providerRef: 'log-1',
      nowMs: NOW_MS,
    });
    assert.deepEqual(outcome, {
      status: 'sent',
      attempts: 1,
      retryDelaySeconds: null,
      nextRetryAt: null,
      cost: 0,
      providerRef: 'log-1',
      lastError: null,
    });
  });

  it('walks the existing NOTIFY backoff while attempts remain', () => {
    assert.deepEqual([...NOTIFY_RETRY_DELAYS_SECONDS], [60, 600, 3600]);
    assert.equal(notifyMaxAttempts(), NOTIFY_RETRY_DELAYS_SECONDS.length);

    const first = buildNotifySendOutcome({ ok: false, attempt: 1, cause: 'timeout', nowMs: NOW_MS });
    assert.equal(first.status, 'queued');
    assert.equal(first.retryDelaySeconds, 60);
    assert.equal(first.nextRetryAt, new Date(NOW_MS + 60_000).toISOString());
    assert.equal(first.attempts, 1);

    const third = buildNotifySendOutcome({ ok: false, attempt: 3, cause: 'timeout', nowMs: NOW_MS });
    assert.equal(third.status, 'queued');
    assert.equal(third.retryDelaySeconds, 3600);
    assert.equal(nextRetryDelay('notify-send', 3), 3600, 'the worker reuses the queue helper');
  });

  it('fails the message once the backoff is exhausted', () => {
    const beyond = buildNotifySendOutcome({ ok: false, attempt: 4, cause: 'timeout', nowMs: NOW_MS });
    assert.equal(beyond.status, 'failed');
    assert.equal(beyond.retryDelaySeconds, null);
    assert.equal(beyond.nextRetryAt, null);
    assert.match(beyond.lastError ?? '', /timeout/);
  });
});

// ============ one attempt ============

describe('processNotifySend', () => {
  it('renders the active template and delivers through the adapter', async () => {
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const client = clientWithTemplate(TEMPLATE_BODY);
    const { outcome, body } = await processNotifySend(job(), { adapter, client, nowMs: NOW_MS });

    assert.equal(body, 'Hello Ada, invoice INT-2026-000001 totals 118.');
    assert.equal(outcome.status, 'sent');
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.providerRef, 'log-1');
    assert.equal(adapter.sent.length, 1);
    assert.deepEqual(adapter.sent[0], {
      channel: 'email',
      to: 'ops@example.com',
      body: 'Hello Ada, invoice INT-2026-000001 totals 118.',
      providerRef: 'log-1',
      at: new Date(NOW_MS).toISOString(),
    });
    assert.deepEqual(client.seen[0]?.values.slice(0, 3), [TENANT, 'email', 'invoice.ready']);
  });

  it('fails terminally when no active template exists, without calling the adapter', async () => {
    const adapter = new LogNotifyAdapter({ now: () => NOW_MS });
    const client = clientWithTemplate(null);
    const { outcome, body } = await processNotifySend(job(), { adapter, client, nowMs: NOW_MS });

    assert.equal(body, '');
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.lastError ?? '', /notify\.template_missing/);
    assert.match(outcome.lastError ?? '', /invoice\.ready/);
    assert.equal(adapter.sent.length, 0);
  });

  it('reschedules on an adapter failure with the backoff for the next attempt', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const { outcome } = await processNotifySend(job({ attempts: 1 }), {
      adapter: failingAdapter('provider 429'),
      client,
      nowMs: NOW_MS,
    });
    assert.equal(outcome.status, 'queued');
    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.retryDelaySeconds, 600);
    assert.equal(outcome.nextRetryAt, new Date(NOW_MS + 600_000).toISOString());
    assert.match(outcome.lastError ?? '', /429/);
  });

  it('maps an adapter throw to a queued outcome without throwing', async () => {
    const throwing: NotifyAdapter = {
      name: 'throwing',
      async send() {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const client = clientWithTemplate(TEMPLATE_BODY);
    const { outcome } = await processNotifySend(job(), { adapter: throwing, client, nowMs: NOW_MS });
    assert.equal(outcome.status, 'queued');
    assert.match(outcome.lastError ?? '', /ECONNREFUSED/);
  });

  it('fails the row once the notify attempts are exhausted', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const { outcome } = await processNotifySend(job({ attempts: 3 }), {
      adapter: failingAdapter('provider down'),
      client,
      nowMs: NOW_MS,
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.attempts, 4);
    assert.equal(outcome.retryDelaySeconds, null);
  });
});

// ============ persistence ============

describe('persistNotifyOutcome', () => {
  it('moves the row to sent with cost and provider ref', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const written = await persistNotifyOutcome(
      client,
      job(),
      buildNotifySendOutcome({ ok: true, attempt: 1, cost: 0, providerRef: 'log-1', nowMs: NOW_MS }),
    );
    assert.equal(written, true);
    const update = client.seen[client.seen.length - 1];
    assert.ok(update?.text.includes('SET status = \'sent\''));
    assert.deepEqual(update?.values, [MESSAGE, TENANT, 0, 'log-1']);
  });

  it('moves the row to failed once retries are exhausted', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const written = await persistNotifyOutcome(
      client,
      job(),
      buildNotifySendOutcome({ ok: false, attempt: 4, cause: 'down', nowMs: NOW_MS }),
    );
    assert.equal(written, true);
    const update = client.seen[client.seen.length - 1];
    assert.ok(update?.text.includes('SET status = \'failed\''));
    assert.deepEqual(update?.values, [MESSAGE, TENANT]);
  });

  it('writes nothing while a retry is pending — the row stays queued', async () => {
    const client = clientWithTemplate(TEMPLATE_BODY);
    const written = await persistNotifyOutcome(
      client,
      job(),
      buildNotifySendOutcome({ ok: false, attempt: 1, cause: 'down', nowMs: NOW_MS }),
    );
    assert.equal(written, false);
    assert.equal(client.seen.length, 0);
  });

  it('exposes the SQL the runtime depends on', () => {
    assert.ok(SELECT_ACTIVE_NOTIFY_TEMPLATE_SQL.includes('FROM notify_templates'));
    assert.ok(SELECT_ACTIVE_NOTIFY_TEMPLATE_SQL.includes('status = \'active\''));
    assert.ok(MARK_NOTIFY_SENT_SQL.includes('UPDATE message_log'));
    assert.ok(MARK_NOTIFY_SENT_SQL.includes('provider_ref'));
    assert.ok(MARK_NOTIFY_FAILED_SQL.includes('UPDATE message_log'));
    assert.ok(CLAIM_DUE_NOTIFY_SQL.includes('FOR UPDATE SKIP LOCKED'));
    assert.ok(CLAIM_DUE_NOTIFY_SQL.includes('status = \'queued\''));
  });
});

// ============ queue wiring ============

describe('notify queue wiring', () => {
  it('adds one claimed notification with observable retries disabled', async () => {
    const added: Array<{ name: string; data: unknown; options: unknown }> = [];
    await enqueueNotifyJob(
      {
        async add(name: string, data: unknown, options: unknown) {
          added.push({ name, data, options });
        },
      } as never,
      job(),
    );
    assert.equal(added.length, 1);
    assert.equal(added[0]?.name, 'notify-send');
    assert.deepEqual(added[0]?.options, {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      jobId: `${MESSAGE}:1`,
    });
  });
});
