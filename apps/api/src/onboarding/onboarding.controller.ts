// Onboarding endpoint — thin HTTP skin over `onboarding/store.ts`
// (peru-anexo-v1.md §11; `db/migrations/002_onboarding.sql`). No domain logic
// lives here: every handler acquires one pooled setup connection and forwards
// it to the store, which owns the step parsing, the pure state machine and the
// SQL. The `Idempotency-Key` header is the only extra request fact the step
// route needs on case creation, so it is read here and passed through
// unchanged. The routes bypass the tenant middleware (see `app.module.ts`):
// the wizard runs before any tenant exists, so there is no tenant context to
// bind — the pooled connection is the setup role migration 002 grants the
// pre-tenant tables to.
import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../tenant/tenant.middleware.ts';
import {
  getOnboardingActa,
  getOnboardingResume,
  getOnboardingStatus,
  submitOnboardingStep,
  type OnboardingStatus,
  type SubmitStepResult,
} from './store.ts';
import type { OnboardingActa } from './service.ts';

/** Correlation header shared with the `{code, message, traceId}` envelope. */
const TRACE_ID_HEADER = 'x-trace-id';

/** Replay key that opens the case, mirroring the billing critical POSTs. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

type HeaderBag = Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderBag, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  return undefined;
}

@Controller('onboarding')
export class OnboardingController {
  private readonly pool: Pool;

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.pool = pool;
  }

  private traceIdOf(headers: HeaderBag): string {
    return readHeader(headers, TRACE_ID_HEADER) ?? randomUUID();
  }

  private async withSetupClient<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }

  /** `GET /v1/onboarding/status` — gate flag plus where the wizard stands. */
  @Get('status')
  status(@Headers() headers: HeaderBag): Promise<OnboardingStatus> {
    const traceId = this.traceIdOf(headers);
    void traceId;
    return this.withSetupClient((client) => getOnboardingStatus(client));
  }

  /** `GET /v1/onboarding/resume` — the open case to reopen the wizard on. */
  @Get('resume')
  resume(@Headers() headers: HeaderBag): Promise<OnboardingStatus> {
    const traceId = this.traceIdOf(headers);
    return this.withSetupClient((client) => getOnboardingResume(client, traceId));
  }

  /** `POST /v1/onboarding/steps/:step` — confirms one wizard step. */
  @Post('steps/:step')
  submit(
    @Param('step') step: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<SubmitStepResult> {
    const traceId = this.traceIdOf(headers);
    const headerKey = readHeader(headers, IDEMPOTENCY_KEY_HEADER);
    return this.withSetupClient((client) =>
      submitOnboardingStep(client, {
        stepRaw: step,
        body,
        headerKey,
        now: new Date().toISOString(),
        traceId,
      }),
    );
  }

  /** `GET /v1/onboarding/acta` — the signed acta of the closed run. */
  @Get('acta')
  acta(@Headers() headers: HeaderBag): Promise<OnboardingActa> {
    const traceId = this.traceIdOf(headers);
    return this.withSetupClient((client) => getOnboardingActa(client, traceId));
  }
}
