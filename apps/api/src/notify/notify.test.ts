// Notify coverage (N1): template render, same-tx enqueue writer, tenant-admin
// gate, management use cases and the worker-owned status transitions.
//
// The SQL client is a small stateful in-memory double: it implements the exact
// statements `notify/notify.service.ts` issues over synthetic rows, so the
// suite exercises the real control flow (guard, template lookup, `to` →
// `recipient` mapping, transitions) without Postgres. All data is synthetic.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  NOTIFY_CHANNELS,
  NOTIFY_STATUSES,
  NOTIFY_TEMPLATE_APPOINTMENT_SCHEDULED,
  NOTIFY_TEMPLATE_INVOICE_ISSUED,
  createTemplate,
  enqueueNotify,
  getActiveTemplate,
  isNotifyAdminRole,
  listMessages,
  listTemplates,
  markDelivered,
  markFailed,
  markSent,
  parseMessageFilters,
  parseNotifyEnqueueInput,
  parseNotifyTemplateCreateInput,
  parseTemplateFilters,
  renderNotifyTemplate,
  sendNotification,
  tryEnqueueNotify,
  type NotifyActor,
  type NotifyClient,
} from './notify.service.ts';

const TENANT_ID = '3f1c9b2e-4d1a-4e6f-8b2c-5a7d9e0f1a2b';
const ADMIN_USER_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ORG_NODE_ID = 'c1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MESSAGE_ID = 'd1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const TRACE = 'trace-notify-1';

// ============ in-memory double ============

interface FakeDb {
  /** Membership row answered to the guard lookup (`null` = no membership). */
  membership: Record<string, unknown> | null;
  /** Active template answered to the enqueue lookup (`null` = none). */
  activeTemplate: Record<string, unknown> | null;
  /** Rows answered to the message list. */
  messages: Record<string, unknown>[];
  /** Rows answered to the template list. */
  templates: Record<string, unknown>[];
  /** Current status of the single message the transitions move. */
  messageStatus: string | null;
  /** `true` simulates a duplicate `(channel, code, version)` on insert. */
  templateConflict: boolean;
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

function templateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    tenant_id: TENANT_ID,
    channel: 'email',
    code: 'invoice.issued',
    version: 2,
    body: 'Invoice {{number}} totals {{total}}.',
    status: 'active',
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    tenant_id: TENANT_ID,
    channel: 'email',
    template: 'invoice.issued',
    recipient: 'ops@example.com',
    status: 'queued',
    cost: 0,
    provider_ref: null,
    at: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

function createFakeDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    membership: membershipRow('ti_admin'),
    activeTemplate: templateRow(),
    messages: [messageRow()],
    templates: [templateRow()],
    messageStatus: 'queued',
    templateConflict: false,
    queries: [],
    auditActions: [],
    ...overrides,
  };
}

/** Dispatches on the statement markers the service emits. */
function createFakeClient(db: FakeDb): NotifyClient {
  return {
    async query(text: string, values: readonly unknown[] = []) {
      db.queries.push({ text, values });
      if (text.includes('FROM memberships m')) {
        return { rows: db.membership === null ? [] : [db.membership] };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: [{ id: ORG_NODE_ID }] };
      }
      if (text.includes("AND status = 'active'")) {
        return { rows: db.activeTemplate === null ? [] : [db.activeTemplate] };
      }
      if (text.includes('INSERT INTO message_log')) {
        return {
          rows: [
            {
              id: 'c2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              tenant_id: values[0],
              channel: values[1],
              template: values[2],
              recipient: values[3],
              status: 'queued',
              cost: 0,
              provider_ref: null,
              at: new Date().toISOString(),
            },
          ],
        };
      }
      if (text.includes('UPDATE message_log')) {
        const wanted = values.slice(3, -2) as string[];
        if (db.messageStatus !== null && wanted.includes(db.messageStatus)) {
          db.messageStatus = values[2] as string;
          return { rows: [messageRow({ status: db.messageStatus })] };
        }
        return { rows: [] };
      }
      if (text.includes('FROM message_log WHERE tenant_id = $1 AND id = $2')) {
        return { rows: db.messageStatus === null ? [] : [messageRow({ status: db.messageStatus })] };
      }
      if (text.includes('FROM message_log WHERE')) {
        return { rows: db.messages };
      }
      if (text.includes('INSERT INTO notify_templates')) {
        if (db.templateConflict) {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        return {
          rows: [
            {
              id: 'e2b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
              tenant_id: values[0],
              channel: values[1],
              code: values[2],
              version: values[3],
              body: values[4],
              status: values[5],
            },
          ],
        };
      }
      if (text.includes('FROM notify_templates')) {
        return { rows: db.templates };
      }
      if (text.includes('INSERT INTO audit_log')) {
        db.auditActions.push(values[2]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function actorFor(db: FakeDb, userId: string = ADMIN_USER_ID): NotifyActor {
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

function catchSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the function to throw');
}

// ============ render ============

describe('renderNotifyTemplate', () => {
  it('replaces every {{var}} slot with the string form of the payload value', () => {
    assert.equal(
      renderNotifyTemplate('Invoice {{number}} totals {{total}}.', { number: 'F001-1', total: 118 }),
      'Invoice F001-1 totals 118.',
    );
  });

  it('tolerates whitespace inside the braces and dotted paths', () => {
    assert.equal(
      renderNotifyTemplate('Hi {{ name }}, {{customer.tier}} plan.', {
        name: 'Ada',
        customer: { tier: 'gold' },
      }),
      'Hi Ada, gold plan.',
    );
  });

  it('renders unknown or nullish variables as an empty string', () => {
    assert.equal(renderNotifyTemplate('Hi {{name}}, {{missing}}!', { name: 'Ada' }), 'Hi Ada, !');
    assert.equal(renderNotifyTemplate('Hi {{name}}!', { name: null }), 'Hi !');
    assert.equal(renderNotifyTemplate('No slots here.', {}), 'No slots here.');
  });
});

// ============ validation ============

describe('channel and role sets', () => {
  it('exposes the three channels', () => {
    assert.deepEqual([...NOTIFY_CHANNELS], ['email', 'sms', 'whatsapp']);
    assert.deepEqual([...NOTIFY_STATUSES], ['queued', 'sent', 'delivered', 'failed']);
  });

  it('recognizes the tenant admin roles only', () => {
    assert.equal(isNotifyAdminRole('ti_admin'), true);
    assert.equal(isNotifyAdminRole('direccion'), true);
    assert.equal(isNotifyAdminRole('medico'), false);
    assert.equal(isNotifyAdminRole('caja'), false);
  });
});

describe('parseNotifyEnqueueInput', () => {
  it('accepts a full body and defaults the payload to {}', () => {
    assert.deepEqual(parseNotifyEnqueueInput({ channel: 'sms', template: 'otp.login', to: '+51999999999' }, TRACE), {
      channel: 'sms',
      template: 'otp.login',
      to: '+51999999999',
      payload: {},
    });
  });

  it('rejects a bad channel, a blank template and a blank to', () => {
    assert.equal(
      codeOf(catchSync(() => parseNotifyEnqueueInput({ channel: 'push', template: 'x', to: 'y' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(catchSync(() => parseNotifyEnqueueInput({ channel: 'email', template: '', to: 'y' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(catchSync(() => parseNotifyEnqueueInput({ channel: 'email', template: 'x', to: '  ' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(catchSync(() => parseNotifyEnqueueInput({ channel: 'email', template: 'x', to: 'y', payload: [] }, TRACE))),
      'validation.failed',
    );
  });
});

describe('parseMessageFilters', () => {
  it('defaults every filter to null and accepts the known pairs', () => {
    assert.deepEqual(parseMessageFilters({}, TRACE), { channel: null, status: null });
    assert.deepEqual(parseMessageFilters({ channel: 'sms', status: 'failed' }, TRACE), {
      channel: 'sms',
      status: 'failed',
    });
  });

  it('rejects an unknown channel and an unknown status', () => {
    assert.equal(codeOf(catchSync(() => parseMessageFilters({ channel: 'push' }, TRACE))), 'validation.failed');
    assert.equal(codeOf(catchSync(() => parseMessageFilters({ status: 'pending' }, TRACE))), 'validation.failed');
  });
});

describe('parseNotifyTemplateCreateInput', () => {
  it('defaults to version 1 in draft', () => {
    assert.deepEqual(
      parseNotifyTemplateCreateInput({ channel: 'email', code: 'invoice.issued', body: 'Hi {{name}}.' }, TRACE),
      { channel: 'email', code: 'invoice.issued', body: 'Hi {{name}}.', version: 1, status: 'draft' },
    );
  });

  it('rejects a blank body, a bad version and a bad status', () => {
    assert.equal(
      codeOf(catchSync(() => parseNotifyTemplateCreateInput({ channel: 'email', code: 'x', body: '' }, TRACE))),
      'validation.failed',
    );
    assert.equal(
      codeOf(
        catchSync(() => parseNotifyTemplateCreateInput({ channel: 'email', code: 'x', body: 'Hi.', version: 0 }, TRACE)),
      ),
      'validation.failed',
    );
    assert.equal(
      codeOf(
        catchSync(() => parseNotifyTemplateCreateInput({ channel: 'email', code: 'x', body: 'Hi.', status: 'queued' }, TRACE)),
      ),
      'validation.failed',
    );
  });
});

describe('parseTemplateFilters', () => {
  it('defaults to active and accepts every lifecycle state', () => {
    assert.deepEqual(parseTemplateFilters({}, TRACE), { status: 'active' });
    assert.deepEqual(parseTemplateFilters({ status: 'draft' }, TRACE), { status: 'draft' });
    assert.deepEqual(parseTemplateFilters({ status: 'retired' }, TRACE), { status: 'retired' });
  });

  it('rejects an unknown status', () => {
    assert.equal(codeOf(catchSync(() => parseTemplateFilters({ status: 'queued' }, TRACE))), 'validation.failed');
  });
});

// ============ template reads ============

describe('getActiveTemplate', () => {
  it('returns the newest active version for the pair', async () => {
    const template = await getActiveTemplate(createFakeClient(createFakeDb()), TENANT_ID, 'email', 'invoice.issued');
    assert.equal(template?.version, 2);
    assert.equal(template?.status, 'active');
  });

  it('returns null when the tenant has no active template', async () => {
    const template = await getActiveTemplate(
      createFakeClient(createFakeDb({ activeTemplate: null })),
      TENANT_ID,
      'sms',
      'otp.login',
    );
    assert.equal(template, null);
  });
});

// ============ same-tx enqueue writer ============

describe('enqueueNotify', () => {
  it('inserts one queued row mapping to (contract) to the recipient column', async () => {
    const db = createFakeDb();
    const message = await enqueueNotify(createFakeClient(db), TENANT_ID, {
      channel: 'email',
      template: 'invoice.issued',
      to: 'ops@example.com',
      payload: { number: 'F001-1' },
    });

    assert.equal(message.status, 'queued');
    assert.equal(message.to, 'ops@example.com');
    assert.ok(!Object.hasOwn(message, 'recipient'), 'the SQL column name never reaches the wire');
    const insert = db.queries.find((entry) => entry.text.includes('INSERT INTO message_log'));
    assert.ok(insert !== undefined, 'the message row is inserted');
    // Contract → SQL mapping: `to` lands in the `recipient` position ($4).
    assert.deepEqual(insert.values, [TENANT_ID, 'email', 'invoice.issued', 'ops@example.com']);
    assert.ok(
      db.queries.every((entry) => !entry.text.includes('BEGIN') && !entry.text.includes('COMMIT')),
      'the writer never opens its own transaction: it joins the business tx',
    );
  });

  it('fails fast when no active template exists for the pair', async () => {
    const db = createFakeDb({ activeTemplate: null });
    const error = await enqueueNotify(createFakeClient(db), TENANT_ID, {
      channel: 'sms',
      template: 'otp.login',
      to: '+51999999999',
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 400);
    assert.equal(codeOf(error), 'notify.template_missing');
    assert.equal(
      db.queries.some((entry) => entry.text.includes('INSERT INTO message_log')),
      false,
      'no row is queued without an active template',
    );
  });
});

describe('tryEnqueueNotify', () => {
  it('resolves the queued row when the template is active', async () => {
    const db = createFakeDb();
    const message = await tryEnqueueNotify(createFakeClient(db), TENANT_ID, {
      channel: 'email',
      template: 'invoice.issued',
      to: 'ops@example.com',
      payload: { number: 'F001-1' },
    });

    assert.equal(message?.status, 'queued');
    assert.equal(message?.to, 'ops@example.com');
  });

  it('resolves null without inserting when no active template exists', async () => {
    const db = createFakeDb({ activeTemplate: null });
    const message = await tryEnqueueNotify(createFakeClient(db), TENANT_ID, {
      channel: 'sms',
      template: 'otp.login',
      to: '+51999999999',
    });

    assert.equal(message, null);
    assert.equal(
      db.queries.some((entry) => entry.text.includes('INSERT INTO message_log')),
      false,
      'no row is queued without an active template',
    );
  });

  it('resolves null on invalid input instead of throwing', async () => {
    const db = createFakeDb();
    const message = await tryEnqueueNotify(createFakeClient(db), TENANT_ID, {
      channel: 'email',
      template: 'invoice.issued',
      to: '   ',
    });

    assert.equal(message, null);
  });

  it('exposes the emitter template codes', () => {
    assert.equal(NOTIFY_TEMPLATE_INVOICE_ISSUED, 'invoice.issued');
    assert.equal(NOTIFY_TEMPLATE_APPOINTMENT_SCHEDULED, 'appointment.scheduled');
  });
});

// ============ management use cases ============

describe('sendNotification', () => {
  it('enqueues directly for an admin and audits the write', async () => {
    const db = createFakeDb();
    const message = await sendNotification(actorFor(db), {
      channel: 'whatsapp',
      template: 'invoice.issued',
      to: '+51999999999',
    });

    assert.equal(message.status, 'queued');
    assert.ok(db.auditActions.includes('notify_message.sent'));
  });

  it('denies a non-admin role with access.denied and inserts nothing', async () => {
    const db = createFakeDb({ membership: membershipRow('medico') });
    const error = await sendNotification(actorFor(db), {
      channel: 'email',
      template: 'invoice.issued',
      to: 'ops@example.com',
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 403);
    assert.equal(codeOf(error), 'access.denied');
    assert.equal(db.queries.some((entry) => entry.text.includes('INSERT INTO message_log')), false);
    assert.ok(db.auditActions.includes('access.denied'), 'the denial is audited');
  });

  it('answers 400 on a bad body before touching the database', async () => {
    const db = createFakeDb();
    const error = await sendNotification(actorFor(db), { channel: 'push', template: '', to: '' }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 400);
    assert.equal(db.queries.length, 0, 'no query runs on a validation failure');
  });
});

describe('listMessages', () => {
  it('returns rows with to (never recipient) and writes no audit', async () => {
    const db = createFakeDb();
    const rows = await listMessages(actorFor(db), { status: 'queued' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.to, 'ops@example.com');
    assert.ok(!Object.hasOwn(rows[0] as object, 'recipient'));
    assert.equal(
      db.queries.filter((entry) => entry.text.includes('INSERT INTO audit_log')).length,
      0,
      'reads write no audit row',
    );
  });

  it('denies a caller without membership', async () => {
    const db = createFakeDb({ membership: null });
    const error = await listMessages(actorFor(db), {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(error), 'access.denied');
  });
});

describe('listTemplates', () => {
  it('lists the active templates for an admin without audit rows', async () => {
    const db = createFakeDb();
    const rows = await listTemplates(actorFor(db), {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.code, 'invoice.issued');
    const select = db.queries.find((entry) => entry.text.includes('FROM notify_templates'));
    assert.ok(select?.text.includes("status = $2"), 'the default read stays on active templates');
    assert.equal(
      db.queries.filter((entry) => entry.text.includes('INSERT INTO audit_log')).length,
      0,
      'reads write no audit row',
    );
  });
});

describe('createTemplate', () => {
  it('registers one version and audits the write', async () => {
    const db = createFakeDb();
    const created = await createTemplate(actorFor(db), {
      channel: 'sms',
      code: 'otp.login',
      body: 'Your code is {{code}}.',
      version: 1,
      status: 'active',
    });
    assert.equal(created.code, 'otp.login');
    assert.equal(created.status, 'active');
    assert.ok(db.auditActions.includes('notify_template.created'));
  });

  it('answers 409 on a duplicate (channel, code, version)', async () => {
    const db = createFakeDb({ templateConflict: true });
    const error = await createTemplate(actorFor(db), {
      channel: 'email',
      code: 'invoice.issued',
      body: 'Hi.',
      version: 2,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 409);
    assert.equal(codeOf(error), 'notify.template_exists');
  });

  it('denies a non-admin role', async () => {
    const db = createFakeDb({ membership: membershipRow('caja') });
    const error = await createTemplate(actorFor(db), {
      channel: 'email',
      code: 'x',
      body: 'Hi.',
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(codeOf(error), 'access.denied');
  });
});

// ============ worker-owned transitions ============

describe('markSent', () => {
  it('moves queued → sent recording cost and providerRef', async () => {
    const db = createFakeDb();
    const sent = await markSent(createFakeClient(db), TENANT_ID, MESSAGE_ID, {
      cost: 0.05,
      providerRef: 'prov-1',
    });
    assert.equal(sent.status, 'sent');
    const update = db.queries.find((entry) => entry.text.includes('UPDATE message_log'));
    assert.ok(update !== undefined, 'the transition runs');
    assert.deepEqual(update.values, [MESSAGE_ID, TENANT_ID, 'sent', 'queued', 0.05, 'prov-1']);
    assert.equal(
      db.queries.filter((entry) => entry.text.includes('INSERT INTO audit_log')).length,
      0,
      'transitions write no audit row',
    );
  });

  it('answers 409 when the row already left queued', async () => {
    const db = createFakeDb({ messageStatus: 'sent' });
    const error = await markSent(createFakeClient(db), TENANT_ID, MESSAGE_ID, {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 409);
    assert.equal(codeOf(error), 'notify.bad_transition');
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    const missing = await markSent(createFakeClient(createFakeDb({ messageStatus: null })), TENANT_ID, MESSAGE_ID, {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(missing), 404);

    const malformed = await markSent(createFakeClient(createFakeDb()), TENANT_ID, 'not-a-uuid', {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(malformed), 400);
  });

  it('rejects a negative cost', async () => {
    const error = await markSent(createFakeClient(createFakeDb()), TENANT_ID, MESSAGE_ID, { cost: -1 }).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 400);
  });
});

describe('markDelivered', () => {
  it('moves sent → delivered', async () => {
    const db = createFakeDb({ messageStatus: 'sent' });
    const delivered = await markDelivered(createFakeClient(db), TENANT_ID, MESSAGE_ID, {});
    assert.equal(delivered.status, 'delivered');
  });

  it('answers 409 when the row never left queued', async () => {
    const db = createFakeDb();
    const error = await markDelivered(createFakeClient(db), TENANT_ID, MESSAGE_ID, {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 409);
  });
});

describe('markFailed', () => {
  it('moves queued → failed and sent → failed', async () => {
    const fromQueued = await markFailed(createFakeClient(createFakeDb()), TENANT_ID, MESSAGE_ID, {
      providerRef: 'err-1',
    });
    assert.equal(fromQueued.status, 'failed');

    const fromSent = await markFailed(
      createFakeClient(createFakeDb({ messageStatus: 'sent' })),
      TENANT_ID,
      MESSAGE_ID,
      {},
    );
    assert.equal(fromSent.status, 'failed');
  });

  it('answers 409 once the row is delivered', async () => {
    const db = createFakeDb({ messageStatus: 'delivered' });
    const error = await markFailed(createFakeClient(db), TENANT_ID, MESSAGE_ID, {}).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.equal(statusOf(error), 409);
  });
});
