// Notify adapter coverage (N2): the `log` adapter records and reports
// success, validates its input without throwing, and the factory keeps a
// documented gate for the real providers (SMTP/WhatsApp/SMS).
//
// Everything here is pure or seam-injected (fixed clock): no Redis, no BullMQ
// connection, no network. All identifiers are synthetic.
// Runner: `node --test src/notify-adapter.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOTIFY_ADAPTER_KINDS,
  LogNotifyAdapter,
  createNotifyAdapter,
  type LoggedNotifySend,
} from './notify-adapter.ts';

const NOW_MS = 1_788_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();

function adapter(): LogNotifyAdapter {
  return new LogNotifyAdapter({ now: () => NOW_MS });
}

// ============ log adapter ============

describe('LogNotifyAdapter', () => {
  it('records the send and reports success with zero cost', async () => {
    const log = adapter();
    const result = await log.send({
      channel: 'email',
      to: 'ops@example.com',
      body: 'Hello Ada, invoice INT-2026-000001 is ready.',
    });

    assert.equal(result.ok, true);
    assert.equal(result.providerRef, 'log-1');
    assert.equal(result.cost, 0);
    assert.equal(result.error, null);
    assert.deepEqual(log.sent, [
      {
        channel: 'email',
        to: 'ops@example.com',
        body: 'Hello Ada, invoice INT-2026-000001 is ready.',
        providerRef: 'log-1',
        at: NOW_ISO,
      },
    ]);
  });

  it('sequences provider refs across sends', async () => {
    const log = adapter();
    const first = await log.send({ channel: 'sms', to: '+51000000001', body: 'one' });
    const second = await log.send({ channel: 'whatsapp', to: '+51000000002', body: 'two' });

    assert.equal(first.providerRef, 'log-1');
    assert.equal(second.providerRef, 'log-2');
    assert.equal(log.sent.length, 2);
  });

  it('returns a failure result — never throws — for an empty destination or body', async () => {
    const log = adapter();
    for (const input of [
      { channel: 'email', to: '   ', body: 'hello' },
      { channel: 'email', to: 'ops@example.com', body: '   ' },
      { channel: '   ', to: 'ops@example.com', body: 'hello' },
    ]) {
      const result = await log.send(input);
      assert.equal(result.ok, false);
      assert.equal(result.providerRef, null);
      assert.match(result.error ?? '', /notify validation failed/);
    }
    assert.equal(log.sent.length, 0, 'invalid inputs are never recorded');
  });

  it('exposes a copy of the recorded sends', async () => {
    const log = adapter();
    await log.send({ channel: 'email', to: 'ops@example.com', body: 'hello' });
    const copy: LoggedNotifySend[] = [...log.sent];
    copy.push({ channel: 'x', to: 'y', body: 'z', providerRef: 'forged', at: NOW_ISO });
    assert.equal(log.sent.length, 1, 'pushing to the copy leaves the adapter untouched');
  });
});

// ============ factory + provider gate ============

describe('createNotifyAdapter', () => {
  it('builds the log adapter by default', async () => {
    const built = createNotifyAdapter();
    assert.equal(built.name, 'log');
    const result = await built.send({ channel: 'sms', to: '+51000000001', body: 'hi' });
    assert.equal(result.ok, true);
  });

  it('advertises the shipped kind plus the documented gates', () => {
    assert.deepEqual([...NOTIFY_ADAPTER_KINDS], ['log', 'smtp', 'whatsapp', 'sms']);
  });

  it('throws with the gate pointer for a real provider kind', () => {
    for (const kind of ['smtp', 'whatsapp', 'sms'] as const) {
      assert.throws(
        () => createNotifyAdapter(kind),
        /not implemented.*notify-adapter\.ts/i,
        `${kind} must fail loudly until its provider class exists`,
      );
    }
  });
});
