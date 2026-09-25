// Shared contract primitives (bases-consolidadas-v1.md §5.1).
//
// These are the smallest pieces every record schema reuses: the identifier and
// timestamp shapes the API emits, the `{code, message, traceId}` error envelope
// and the JSONB bag type. The module deliberately uses only the stable Zod API
// surface (`object`, `string`, `number`, `boolean`, `array`, `record`, `enum`,
// `nullable`, `regex`) so the schemas keep working across Zod 3.x and 4.x.
//
// Convention: the API row mappers emit camelCase keys, a plain string status
// (the database owns the state machine, so the contract does not re-declare it
// as an enum) and `string | null` for every optional timestamp — see
// `type IsoValue = string | null` in `apps/api/src/*/*.service.ts`.
import { z } from 'zod';

/** Canonical UUID shape used by every primary key and foreign key. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Calendar date (`YYYY-MM-DD`) the API uses for date-only columns. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Offset-aware ISO-8601 timestamp, the shape `toIso` produces. */
export const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** UUID string. */
export const uuidSchema = z.string().regex(UUID_RE, 'Expected a UUID');

/** `YYYY-MM-DD` calendar date. */
export const isoDateSchema = z.string().regex(ISO_DATE_RE, 'Expected a YYYY-MM-DD date');

/** Offset-aware ISO-8601 timestamp. */
export const isoDateTimeSchema = z
  .string()
  .regex(ISO_DATETIME_RE, 'Expected an ISO-8601 timestamp with an offset');

/**
 * Nullable timestamp or date, mirroring `IsoValue`. The field is present and
 * explicitly `null` when the column is empty — never omitted.
 */
export const isoValueSchema = z.string().nullable();

/** Free-form JSONB bag (contacts, fiscal payload, `totals`, `items`, `diff`). */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

/** One JSONB array element as the API returns it. */
export const jsonArraySchema = z.array(z.unknown());

/** Field name `{code, message, traceId}` convention, plus the deny `reason`. */
export const apiErrorSchema = z.object({
  /** Machine-readable code, e.g. `access.denied` or `tenant.missing`. */
  code: z.string(),
  /** Human-readable message (safe to display, carries no tenant data). */
  message: z.string(),
  /** Present on `access.denied`: the guard rule term that denied the action. */
  reason: z.string().optional(),
  /** Correlation id shared with the API logs; always echoed when provided. */
  traceId: z.string().optional(),
});

/** Error envelope as the web client consumes it. */
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Correlation header name shared by the API, the proxy and the web client. */
export const TRACE_ID_HEADER = 'x-trace-id';

/** Idempotency header name required by the critical POST routes. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * Denial contract surfaced by the UI guard: the same envelope the API builds
 * for `access.denied`, so a preemptive UI denial and an API denial render
 * identically and carry the same correlation id.
 */
export interface DeniedState {
  readonly code: 'access.denied';
  readonly reason: string;
  readonly traceId: string;
}

// Onboarding HTTP contracts (H3): re-exported here so the public entry point
// (`index.ts`, which already re-exports this module) exposes them without
// touching the entry file. `onboarding.ts` imports only `zod`, so this
// re-export creates no import cycle back into this module.
export * from './onboarding.ts';

// Signed file contracts (H2): same wiring as onboarding — `files.ts` imports
// only `zod`, so re-exporting it here exposes the schemas through the public
// entry point without touching `index.ts` and without an import cycle.
export * from './files.ts';

// Keyset pagination contracts (R1): same wiring — `pagination.ts` imports
// only `zod`, so this re-export exposes the cursor/limit/envelope helpers
// through the public entry point without touching `index.ts`.
export * from './pagination.ts';
