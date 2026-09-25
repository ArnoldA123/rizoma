# @rizoma/workers

Outbox dispatcher and provider/fiscal adapters for Rizoma. The workers own
every call to an external provider: the API enqueues intents and reads state,
and the core holds no fiscal or provider logic
(`docs/crm-maleable/bases-consolidadas-v1.md` §5.3, "solo workers llaman
adaptadores").

## What runs here

- **Outbox dispatch** — drains `outbox` rows and turns them into queue jobs.
- **Fiscal emission** — calls the active `FiscalAdapter` (`manual_v1` or
  `sunat_v1`), persists the raw payload and the resulting `fiscal_status`.
- **Notifications** — email today (WhatsApp/SMS in MVP2), without blocking the
  clinical flow.
- **Webhook delivery** — signed, at-least-once delivery to tenant endpoints.

This package currently ships pure configuration and adapters plus tests. The
BullMQ runtime wiring (worker process, Redis connection, outbox polling) lands
in a later task. `bullmq` and `ioredis` are declared in `package.json` but are
not imported by the pure modules, so tests run without installing them.

## Queues and retries

Queue names and backoff schedules live in `src/queues.ts`.

| Queue | Name | Attempts | Backoff (seconds) |
|-------|------|----------|-------------------|
| Fiscal emission | `fiscal-emit` | 5 | 60, 300, 1800, 7200, 21600 |
| Notifications | `notify-send` | 3 | 60, 600, 3600 |
| Webhook delivery | `webhook-deliver` | 5 | 60, 300, 1800, 7200, 21600 |

`nextRetryDelay(queue, attempt)` returns the delay before a 1-based retry
attempt, or `null` once attempts are exhausted. Idempotency uses the
`Idempotency-Key` header with a 24 h window (`decideIdempotency`,
`idempotencyExpiry`): same key + same body replays the stored response, same
key + different body is a `409 idempotency_conflict`.

## Fiscal adapters

`src/fiscal/adapter.ts` implements `FiscalAdapter.emit(invoice)`.

- **`manual_v1`** — local internal folio `INT-YYYY-NNNNNN` with an injected
  counter, document lifecycle `borrador → emitida → anulada`; an annulment
  requires a motivo and an annulled document never returns to `emitida`.
- **`sunat_v1`** (beta, manual by default) — simulates the SUNAT send with an
  injected transport. An accepted result maps to `accepted`, a rejection maps
  to `rejected` with its cause, and a timeout or transport error degrades to
  `contingency` with an internal folio and a scheduled retry. It never throws a
  blocking error, so no fiscal failure blocks the cashier.

`computeIGV(base, rate = 0.18)` applies the parametrizable IGV with 2-decimal
rounding per line (`peru-anexo-v1.md` §3.1). The raw fiscal payload returned in
`FiscalResult.payload` is frozen for immutable audit and replay.

## Testing locally with Redis

Tests are dependency-free and run with the Node test runner:

```bash
# from the repo root
node --test apps/api/src/files/paths.test.ts apps/workers/src/fiscal/adapter.test.ts
# or inside this package
npm test --workspace @rizoma/workers
```

Redis 7 runs in the local Compose stack (`infra/docker/compose.yml`) on
`localhost:6379`. Once the BullMQ runtime is wired, start it with
`npm run compose:up` and point the worker at
`redis://localhost:6379`. The pure modules in this package need no Redis.
