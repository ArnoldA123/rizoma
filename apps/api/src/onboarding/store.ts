// Onboarding setup store — pre-tenant persistence of the first-run wizard
// (peru-anexo-v1.md §11; tables in `db/migrations/002_onboarding.sql`).
//
// Deliberately plain, like `billing/billing.service.ts`: no decorators, because
// `npm test` loads the sources through Node's strip-only type stripping, which
// rejects decorator syntax. The HTTP skin lives in `onboarding.controller.ts`
// and stays thin; this module owns the use case end to end:
//   1. parse the step number and the `{data}` envelope;
//   2. load the open `onboarding_cases` row (or open the case on step 1) and
//      run the pure state machine (`advance` in `service.ts`), which owns the
//      RUC/ARCO/MFA validators, the ordering rule and the acta hash;
//   3. persist the returned record and, on the final step, mark `app_state`
//      with `initialized_at` so business routes stop answering pending.
//
// Setup-role note (migration 002): `onboarding_cases` and `app_state` are
// pre-tenant data without RLS — the tenant does not exist yet while the wizard
// runs — so the controller reaches this store through the pooled admin
// connection (`PG_POOL`), bypassing the tenant middleware (see `app.module.ts`:
// the `/v1/onboarding/*` routes are excluded from it). No `audit_log` row is
// written here: that table is tenant-scoped and the signed acta hash is the
// evidence of the run. Likewise `onboarding_acta` (a business table with
// `tenant_id NOT NULL` + RLS) cannot be inserted before a tenant exists, so
// `GET acta` serves the signed payload of the closed case — the exact hash a
// later tenant provisioning persists into `onboarding_acta`.
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  LAST_STEP,
  advance,
  resumeFrom,
  sha256Hex,
  type OnboardingActa,
  type OnboardingCase,
} from './service.ts';

/** Machine-readable `onboarding.*` codes this module exposes. */
export const ONBOARDING_ERROR = {
  invalidStep: 'onboarding.invalid_step',
  invalidBody: 'onboarding.invalid_body',
  noCase: 'onboarding.no_case',
  outOfOrder: 'onboarding.out_of_order',
  closed: 'onboarding.closed',
  alreadyInitialized: 'onboarding.already_initialized',
  notCompleted: 'onboarding.not_completed',
  idempotencyConflict: 'onboarding.idempotency_conflict',
  writeFailed: 'onboarding.write_failed',
} as const;
export type OnboardingErrorCode = (typeof ONBOARDING_ERROR)[keyof typeof ONBOARDING_ERROR];

/** Minimal query surface, satisfied by the pooled client of one request. */
export interface OnboardingDbClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

function onboardingError(
  code: OnboardingErrorCode,
  message: string,
  status: number,
  traceId: string,
): HttpException {
  return new HttpException({ code, message, traceId }, status);
}

function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

/** JSONB columns arrive as objects or as text, depending on the driver. */
function toJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    try {
      return toJsonObject(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The `sites` column stores the bare array the state machine keeps. */
function toSitesArray(value: unknown): OnboardingCase['sites'] {
  if (value === null || value === undefined) return null;
  const parsed: unknown =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (Array.isArray(parsed)) return parsed as OnboardingCase['sites'];
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { sites?: unknown }).sites)) {
    return (parsed as { sites: OnboardingCase['sites'] }).sites;
  }
  return null;
}

function jsonParam(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// ============ row shape ============

const CASE_COLUMNS =
  'id, idempotency_key, current_step, status, organizer, sites, identity, billing, admin_user, acta_hash, created_at, updated_at';

/** Maps one `onboarding_cases` row onto the camelCase case shape. */
export function mapOnboardingCase(row: Record<string, unknown>): OnboardingCase {
  return {
    id: readString(row.id) ?? '',
    idempotencyKey: readString(row.idempotency_key) ?? '',
    currentStep: typeof row.current_step === 'number' ? row.current_step : Number(row.current_step),
    status: (readString(row.status) ?? 'draft') as OnboardingCase['status'],
    organizer: (toJsonObject(row.organizer) ?? null) as OnboardingCase['organizer'],
    sites: toSitesArray(row.sites),
    identity: (toJsonObject(row.identity) ?? null) as OnboardingCase['identity'],
    billing: (toJsonObject(row.billing) ?? null) as OnboardingCase['billing'],
    adminUser: (toJsonObject(row.admin_user) ?? null) as OnboardingCase['adminUser'],
    actaHash: readString(row.acta_hash) ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Rebuilds the signable payload of a case — the shape `advance` hashes. */
export function actaPayloadOf(record: OnboardingCase): OnboardingActa['payload'] {
  return {
    organizer: record.organizer,
    sites: record.sites,
    identity: record.identity,
    billing: record.billing,
    adminUser: record.adminUser,
    idempotencyKey: record.idempotencyKey,
  };
}

// ============ SQL ============

const SELECT_INITIALIZED_SQL = `SELECT value FROM app_state WHERE key = 'initialized_at'`;
const UPSERT_INITIALIZED_SQL = `INSERT INTO app_state (key, value)
VALUES ('initialized_at', to_jsonb($1::text))
ON CONFLICT (key) DO NOTHING`;
const SELECT_LATEST_CASE_SQL = `SELECT ${CASE_COLUMNS}
FROM onboarding_cases ORDER BY updated_at DESC LIMIT 1`;
const SELECT_CASE_BY_KEY_SQL = `SELECT ${CASE_COLUMNS}
FROM onboarding_cases WHERE idempotency_key = $1`;
const INSERT_CASE_SQL = `INSERT INTO onboarding_cases
  (idempotency_key, current_step, status, organizer, sites, identity, billing, admin_user, acta_hash)
VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9)
RETURNING ${CASE_COLUMNS}`;
const UPDATE_CASE_SQL = `UPDATE onboarding_cases
SET current_step = $2, status = $3, organizer = $4::jsonb, sites = $5::jsonb,
    identity = $6::jsonb, billing = $7::jsonb, admin_user = $8::jsonb,
    acta_hash = $9, updated_at = now()
WHERE id = $1
RETURNING ${CASE_COLUMNS}`;
const SELECT_ACTA_BY_CASE_SQL = `SELECT hash, payload
FROM onboarding_acta WHERE case_id = $1
ORDER BY created_at DESC LIMIT 1`;

// ============ request parsing ============

/** Parses the `:step` path segment into a 1..7 step number. */
export function parseOnboardingStep(raw: unknown, traceId: string): number {
  const step = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(step) || step < 1 || step > LAST_STEP) {
    throw onboardingError(
      ONBOARDING_ERROR.invalidStep,
      `Invalid step (expected 1-${LAST_STEP})`,
      400,
      traceId,
    );
  }
  return step;
}

/** Reads the `{data}` envelope of a step submission. */
export function readStepData(body: unknown): unknown {
  return asRecord(body).data;
}

/**
 * Resolves the idempotency key that opens a case: the header wins, then the
 * body field, then a fresh uuid. Later steps accept the key and ignore it —
 * the case key is immutable once the row exists.
 */
export function resolveCaseKey(
  headerKey: string | undefined,
  body: unknown,
): string {
  const header = headerKey?.trim() ?? '';
  if (header !== '') return header;
  const fromBody = readString(asRecord(body).idempotencyKey)?.trim() ?? '';
  if (fromBody !== '') return fromBody;
  return randomUUID();
}

// ============ reads ============

/** True once the final step stored `initialized_at` in `app_state`. */
export async function isInitialized(client: OnboardingDbClient): Promise<boolean> {
  const result = await client.query(SELECT_INITIALIZED_SQL);
  return readRows(result).length > 0;
}

/** Newest case, or `null` before the first step is ever confirmed. */
export async function loadLatestCase(
  client: OnboardingDbClient,
): Promise<OnboardingCase | null> {
  const result = await client.query(SELECT_LATEST_CASE_SQL);
  const row = readRows(result)[0];
  return row === undefined ? null : mapOnboardingCase(row);
}

/** Step the wizard must reopen on: the open step, or `null` once closed. */
export function nextStepOf(record: OnboardingCase | null): number | null {
  if (record === null) return 1;
  if (record.status === 'closed') return null;
  return resumeFrom(record);
}

export interface OnboardingStatus {
  readonly initialized: boolean;
  readonly case: OnboardingCase | null;
  readonly nextStep: number | null;
}

/** `GET status` — the gate flag plus where the wizard stands. */
export async function getOnboardingStatus(
  client: OnboardingDbClient,
): Promise<OnboardingStatus> {
  const initialized = await isInitialized(client);
  const record = await loadLatestCase(client);
  return { initialized, case: record, nextStep: nextStepOf(record) };
}

/**
 * `GET resume` — the full open case. Answers 404 before the first step and
 * 409 once the acta closed the run (there is nothing left to resume).
 */
export async function getOnboardingResume(
  client: OnboardingDbClient,
  traceId: string,
): Promise<OnboardingStatus> {
  const status = await getOnboardingStatus(client);
  if (status.case === null) {
    throw onboardingError(ONBOARDING_ERROR.noCase, 'No onboarding case was opened yet', 404, traceId);
  }
  if (status.case.status === 'closed') {
    throw onboardingError(
      ONBOARDING_ERROR.closed,
      'The onboarding case is already closed',
      409,
      traceId,
    );
  }
  return status;
}

// ============ writes ============

export interface SubmitStepInput {
  readonly stepRaw: unknown;
  readonly body: unknown;
  readonly headerKey: string | undefined;
  readonly now: string;
  readonly traceId: string;
}

export interface SubmitStepResult {
  readonly case: OnboardingCase;
  readonly nextStep: number | null;
  readonly acta: OnboardingActa | null;
}

function toStepColumns(record: OnboardingCase): readonly unknown[] {
  return [
    record.idempotencyKey,
    record.currentStep,
    record.status,
    jsonParam(record.organizer),
    jsonParam(record.sites),
    jsonParam(record.identity),
    jsonParam(record.billing),
    jsonParam(record.adminUser),
    record.actaHash,
  ];
}

/**
 * `POST steps/:n` — confirms the current step through the pure state machine
 * and persists the returned record. The first call (step 1, no open case)
 * opens the case; a replayed open with the same idempotency key collapses onto
 * the existing row instead of opening a second one. The final step persists
 * the closed case and marks `app_state` inside one transaction.
 */
export async function submitOnboardingStep(
  client: OnboardingDbClient,
  input: SubmitStepInput,
): Promise<SubmitStepResult> {
  const step = parseOnboardingStep(input.stepRaw, input.traceId);
  const data = readStepData(input.body);

  if (await isInitialized(client)) {
    throw onboardingError(
      ONBOARDING_ERROR.alreadyInitialized,
      'Onboarding already finished',
      409,
      input.traceId,
    );
  }

  const latest = await loadLatestCase(client);
  const open = latest !== null && latest.status !== 'closed' ? latest : null;
  if (latest !== null && open === null) {
    throw onboardingError(
      ONBOARDING_ERROR.closed,
      'The onboarding case is already closed',
      409,
      input.traceId,
    );
  }

  if (open === null) {
    if (step !== 1) {
      throw onboardingError(
        ONBOARDING_ERROR.outOfOrder,
        'The first step to confirm is step 1',
        400,
        input.traceId,
      );
    }
    const idempotencyKey = resolveCaseKey(input.headerKey, input.body);
    const draft: OnboardingCase = {
      id: '',
      idempotencyKey,
      currentStep: 1,
      status: 'draft',
      organizer: null,
      sites: null,
      identity: null,
      billing: null,
      adminUser: null,
      actaHash: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const decided = advance(draft, { step: 1, data });
    if (!decided.ok) {
      throw onboardingError(ONBOARDING_ERROR.invalidBody, decided.reason, 400, input.traceId);
    }
    let inserted: readonly Record<string, unknown>[];
    try {
      inserted = readRows(await client.query(INSERT_CASE_SQL, toStepColumns(decided.record)));
    } catch (error) {
      if (sqlState(error) === '23505') {
        const existing = readRows(await client.query(SELECT_CASE_BY_KEY_SQL, [idempotencyKey]))[0];
        if (existing !== undefined) {
          const record = mapOnboardingCase(existing);
          return { case: record, nextStep: nextStepOf(record), acta: null };
        }
        throw onboardingError(
          ONBOARDING_ERROR.idempotencyConflict,
          'The idempotency key is already in use',
          409,
          input.traceId,
        );
      }
      throw error;
    }
    const row = inserted[0];
    if (row === undefined) {
      throw onboardingError(
        ONBOARDING_ERROR.writeFailed,
        'Case insert returned no row',
        500,
        input.traceId,
      );
    }
    const record = mapOnboardingCase(row);
    return { case: record, nextStep: decided.nextStep, acta: decided.acta };
  }

  const decided = advance(open, { step, data });
  if (!decided.ok) {
    const status = decided.reason === 'step.out_of_order' ? 400 : 400;
    const code =
      decided.reason === 'step.out_of_order'
        ? ONBOARDING_ERROR.outOfOrder
        : decided.reason === 'case.closed'
          ? ONBOARDING_ERROR.closed
          : ONBOARDING_ERROR.invalidBody;
    throw onboardingError(code, decided.reason, status, input.traceId);
  }

  if (decided.acta === null) {
    const updated = readRows(
      await client.query(UPDATE_CASE_SQL, [open.id, ...toStepColumns(decided.record).slice(1)]),
    )[0];
    if (updated === undefined) {
      throw onboardingError(
        ONBOARDING_ERROR.writeFailed,
        'Case update returned no row',
        500,
        input.traceId,
      );
    }
    const record = mapOnboardingCase(updated);
    return { case: record, nextStep: decided.nextStep, acta: null };
  }

  await client.query('BEGIN');
  try {
    const updated = readRows(
      await client.query(UPDATE_CASE_SQL, [open.id, ...toStepColumns(decided.record).slice(1)]),
    )[0];
    if (updated === undefined) {
      throw onboardingError(
        ONBOARDING_ERROR.writeFailed,
        'Case update returned no row',
        500,
        input.traceId,
      );
    }
    await client.query(UPSERT_INITIALIZED_SQL, [input.now]);
    await client.query('COMMIT');
    return { case: mapOnboardingCase(updated), nextStep: null, acta: decided.acta };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best effort: the original failure is the one that must surface
    }
    throw error;
  }
}

// ============ acta ============

/**
 * `GET acta` — the signed acta of the closed case. Prefers the business row
 * (`onboarding_acta`, written once a tenant exists) and otherwise serves the
 * payload of the closed case with its stored hash, recomputing it when the row
 * predates the hash column. Answers 404 before any case and 409 while the
 * wizard is still open.
 */
export async function getOnboardingActa(
  client: OnboardingDbClient,
  traceId: string,
): Promise<OnboardingActa> {
  const record = await loadLatestCase(client);
  if (record === null) {
    throw onboardingError(ONBOARDING_ERROR.noCase, 'No onboarding case was opened yet', 404, traceId);
  }
  if (record.status !== 'closed') {
    throw onboardingError(
      ONBOARDING_ERROR.notCompleted,
      'The onboarding run is not completed yet',
      409,
      traceId,
    );
  }
  if (record.id !== '') {
    const stored = readRows(await client.query(SELECT_ACTA_BY_CASE_SQL, [record.id]))[0];
    if (stored !== undefined) {
      const payload = toJsonObject(stored.payload);
      const hash = readString(stored.hash) ?? '';
      if (payload !== null && /^[0-9a-f]{64}$/.test(hash)) {
        return {
          hash,
          payload: {
            organizer: (payload.organizer ?? null) as OnboardingActa['payload']['organizer'],
            sites: (Array.isArray(payload.sites) ? payload.sites : null) as OnboardingActa['payload']['sites'],
            identity: (payload.identity ?? null) as OnboardingActa['payload']['identity'],
            billing: (payload.billing ?? null) as OnboardingActa['payload']['billing'],
            adminUser: (payload.adminUser ?? null) as OnboardingActa['payload']['adminUser'],
            idempotencyKey:
              readString(payload.idempotencyKey) ?? record.idempotencyKey,
          },
        };
      }
    }
  }
  const payload = actaPayloadOf(record);
  return { hash: record.actaHash ?? sha256Hex(payload), payload };
}
