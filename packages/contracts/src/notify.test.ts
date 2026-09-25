// Notify contract tests — synthetic payloads only, no live API involved.
//
// They protect the N1 wire property: the public field is `to` (the SQL column
// is `recipient` — the service owns that mapping, never the contract), the
// channel set stays `email|sms|whatsapp`, the status set mirrors the SQL
// CHECK (`queued|sent|delivered|failed`) and templates expose their lifecycle.
// Runner: `node --test src/notify.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  notifyChannelSchema,
  notifyMessageListSchema,
  notifyMessageRecordSchema,
  notifySendInputSchema,
  notifyStatusSchema,
  notifyTemplateCreateInputSchema,
  notifyTemplateListSchema,
  notifyTemplateRecordSchema,
  notifyTemplateStatusSchema,
} from './notify.ts';

/** Synthetic identifiers — demo data, never production values. */
const TENANT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE,
    tenantId: TENANT,
    channel: 'email',
    template: 'invoice.issued',
    to: 'ops@example.com',
    status: 'queued',
    cost: 0,
    providerRef: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function templateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEMPLATE,
    tenantId: TENANT,
    channel: 'email',
    code: 'invoice.issued',
    version: 1,
    body: 'Invoice {{number}} totals {{total}}.',
    status: 'active',
    ...overrides,
  };
}

test('channel set stays email|sms|whatsapp', () => {
  assert.equal(notifyChannelSchema.parse('email'), 'email');
  assert.equal(notifyChannelSchema.parse('sms'), 'sms');
  assert.equal(notifyChannelSchema.parse('whatsapp'), 'whatsapp');
  assert.throws(() => notifyChannelSchema.parse('push'));
  assert.throws(() => notifyChannelSchema.parse(''));
});

test('status set mirrors the message_log CHECK', () => {
  for (const status of ['queued', 'sent', 'delivered', 'failed']) {
    assert.equal(notifyStatusSchema.parse(status), status);
  }
  assert.throws(() => notifyStatusSchema.parse('pending'));
  assert.throws(() => notifyStatusSchema.parse(''));
});

test('template status stays draft|active|retired', () => {
  assert.equal(notifyTemplateStatusSchema.parse('draft'), 'draft');
  assert.equal(notifyTemplateStatusSchema.parse('active'), 'active');
  assert.equal(notifyTemplateStatusSchema.parse('retired'), 'retired');
  assert.throws(() => notifyTemplateStatusSchema.parse('queued'));
});

test('send body requires channel, template and to with a default payload', () => {
  const parsed = notifySendInputSchema.parse({
    channel: 'sms',
    template: 'otp.login',
    to: '+51999999999',
  });
  assert.equal(parsed.channel, 'sms');
  assert.deepEqual(parsed.payload, {});
  assert.equal(
    notifySendInputSchema.parse({
      channel: 'email',
      template: 'invoice.issued',
      to: 'ops@example.com',
      payload: { number: 'F001-1', total: 118 },
    }).payload['total'],
    118,
  );
});

test('send body rejects a blank template, a blank to and an unknown channel', () => {
  assert.throws(() =>
    notifySendInputSchema.parse({ channel: 'email', template: '', to: 'ops@example.com' }),
  );
  assert.throws(() =>
    notifySendInputSchema.parse({ channel: 'email', template: 'invoice.issued', to: '  ' }),
  );
  assert.throws(() =>
    notifySendInputSchema.parse({ channel: 'push', template: 'invoice.issued', to: 'ops@example.com' }),
  );
  assert.throws(() => notifySendInputSchema.parse({ channel: 'email', template: 'invoice.issued' }));
});

test('message record exposes to (never recipient) with cost and providerRef', () => {
  const parsed = notifyMessageRecordSchema.parse(messageRow());
  assert.equal(parsed.to, 'ops@example.com');
  assert.equal(parsed.cost, 0);
  assert.equal(parsed.providerRef, null);
  assert.ok(!Object.hasOwn(parsed, 'recipient'), 'the wire shape never carries the SQL column name');
  assert.equal(
    notifyMessageRecordSchema.strict().safeParse({ ...messageRow(), recipient: 'x' }).success,
    false,
    'a recipient field where none belongs fails validation',
  );
  assert.equal(notifyMessageListSchema.parse([messageRow()]).length, 1);
});

test('message record accepts every lifecycle status', () => {
  for (const status of ['queued', 'sent', 'delivered', 'failed']) {
    assert.equal(notifyMessageRecordSchema.parse(messageRow({ status })).status, status);
  }
});

test('template create body defaults to version 1 in draft', () => {
  const parsed = notifyTemplateCreateInputSchema.parse({
    channel: 'whatsapp',
    code: 'visit.reminder',
    body: 'Hi {{name}}, see you {{when}}.',
  });
  assert.equal(parsed.version, 1);
  assert.equal(parsed.status, 'draft');
});

test('template create body rejects a blank code, a blank body and a bad version', () => {
  assert.throws(() =>
    notifyTemplateCreateInputSchema.parse({ channel: 'email', code: '', body: 'Hi {{name}}.' }),
  );
  assert.throws(() =>
    notifyTemplateCreateInputSchema.parse({ channel: 'email', code: 'x', body: '  ' }),
  );
  assert.throws(() =>
    notifyTemplateCreateInputSchema.parse({ channel: 'email', code: 'x', body: 'Hi.', version: 0 }),
  );
});

test('template record carries the lifecycle and the list is an array of it', () => {
  const parsed = notifyTemplateRecordSchema.parse(templateRow());
  assert.equal(parsed.code, 'invoice.issued');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.status, 'active');
  assert.equal(notifyTemplateListSchema.parse([templateRow()]).length, 1);
});
