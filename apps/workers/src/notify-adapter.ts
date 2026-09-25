// Notify channel adapters (N2).
//
// Only workers call adapters; the API enqueues intents (`message_log` rows in
// `queued`) and reads state. Every adapter returns a result instead of
// throwing for a delivery problem: one bad destination or provider outage must
// never crash the `notify-send` worker — the runtime maps the result to
// `sent` (terminal), `queued` (BullMQ delayed retry) or `failed` (terminal).
//
// Shipped adapter:
// - `log`: records the send in memory and reports success with zero cost.
//   Local/demo default. No network, no credentials.
//
// ---- Provider gate (real SMTP / WhatsApp / SMS; NOT implemented) ----
// To plug a real provider, add a class implementing `NotifyAdapter` in this
// file and extend the `createNotifyAdapter` switch — nothing else changes
// (the `notify-send` runtime depends only on the interface):
// - `smtp` (channel `email`): read `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
//   `SMTP_PASS`, `SMTP_FROM` from the environment and send via SMTP.
// - `whatsapp` (channel `whatsapp`): read `WHATSAPP_API_TOKEN` and
//   `WHATSAPP_PHONE_NUMBER_ID` from the environment (Cloud API).
// - `sms` (channel `sms`): read `SMS_API_KEY` / `SMS_SENDER_ID` from the
//   environment of the chosen SMS gateway.
// Credentials come from the environment only — never from code, the job, or
// the database row. Until a provider class exists, `createNotifyAdapter`
// throws for any non-`log` kind with this same pointer.
//
// Pure and dependency-free: no `bullmq`, no `fetch`, so tests import this
// module without Redis or network. All identifiers in tests are synthetic.

/** Adapter kinds: `log` ships; the rest are documented gates (see above). */
export const NOTIFY_ADAPTER_KINDS = ['log', 'smtp', 'whatsapp', 'sms'] as const;

export type NotifyAdapterKind = (typeof NOTIFY_ADAPTER_KINDS)[number];

/** One delivery request: already-rendered body plus its destination. */
export interface NotifySendInput {
  /** Channel from `message_log.channel` (`email`, `sms`, `whatsapp`). */
  readonly channel: string;
  /** Destination address (the SQL `recipient` column). */
  readonly to: string;
  /** Rendered template body — the adapter never renders. */
  readonly body: string;
}

/** Adapter answer: success facts, or a failure cause for the retry policy. */
export interface NotifySendResult {
  readonly ok: boolean;
  /** Provider-side id (`log-<n>` for the log adapter); `null` on failure. */
  readonly providerRef: string | null;
  /** Billed cost in major units; `0` for the log adapter. */
  readonly cost: number;
  /** Failure cause; `null` on success. */
  readonly error: string | null;
}

/** Transport contract the `notify-send` runtime depends on. */
export interface NotifyAdapter {
  readonly name: string;
  send(input: NotifySendInput): Promise<NotifySendResult>;
}

/** One recorded `log` send, kept in memory for local/demo inspection. */
export interface LoggedNotifySend extends NotifySendInput {
  readonly providerRef: string;
  readonly at: string;
}

function failure(error: string): NotifySendResult {
  return { ok: false, providerRef: null, cost: 0, error };
}

/**
 * Local/demo adapter: validates the input, records it, and reports success.
 * Stateless apart from the in-memory `sent` list and the sequence that mints
 * `providerRef`; inject `now` so tests control the clock.
 */
export class LogNotifyAdapter implements NotifyAdapter {
  readonly name = 'log';
  private sequence = 0;
  private readonly sentMessages: LoggedNotifySend[] = [];
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Sends recorded so far, oldest first (a copy; the adapter owns the list). */
  get sent(): readonly LoggedNotifySend[] {
    return [...this.sentMessages];
  }

  async send(input: NotifySendInput): Promise<NotifySendResult> {
    if (typeof input.to !== 'string' || input.to.trim() === '') {
      return failure('notify validation failed: to is required');
    }
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      return failure('notify validation failed: body is required');
    }
    if (typeof input.channel !== 'string' || input.channel.trim() === '') {
      return failure('notify validation failed: channel is required');
    }
    this.sequence += 1;
    const providerRef = `log-${this.sequence}`;
    this.sentMessages.push({
      channel: input.channel,
      to: input.to,
      body: input.body,
      providerRef,
      at: new Date(this.now()).toISOString(),
    });
    return { ok: true, providerRef, cost: 0, error: null };
  }
}

/**
 * Builds the adapter for one kind. Only `log` exists today; any other kind
 * throws with the pointer to this file's provider gate instead of silently
 * falling back, so a misconfigured worker fails loudly at startup.
 */
export function createNotifyAdapter(kind: NotifyAdapterKind = 'log'): NotifyAdapter {
  if (kind === 'log') return new LogNotifyAdapter();
  throw new Error(
    `notify adapter '${kind}' is not implemented: add a '${kind}' class implementing ` +
      `NotifyAdapter in apps/workers/src/notify-adapter.ts (provider gate) and wire its ` +
      `credentials from the environment`,
  );
}
