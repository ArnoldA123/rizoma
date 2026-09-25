// Browser API client for the first-run onboarding wizard (H3).
//
// One module owns the path, the verb, the contract schema and the replay key
// of every call the wizard makes, so the screen never assembles a URL or a
// body by hand. Same three rules as `lib/salud-api.ts`, for the same reasons:
//
//   1. the response is parsed with the `@rizoma/contracts` schema of its
//      endpoint, so a drift fails at the edge with `api.contract_mismatch`;
//   2. every step submission carries a fresh `Idempotency-Key` per *user
//      intent* — generated inside the call, never inside a retry loop — which
//      is also the key that opens the case on step 1;
//   3. the payload is pre-flighted with the step schema the API service
//      validates against, so an invalid step is refused in the browser.
//
// The wizard runs before any tenant exists (pre-tenant setup, migration 002),
// so these calls carry no tenant fact: the API serves them outside the tenant
// middleware and the proxy forwards them like any other same-origin call.
import {
  onboardingActaSchema,
  onboardingStatusResponseSchema,
  onboardingStepInputSchema,
  onboardingStepResponseSchema,
  type OnboardingActa,
  type OnboardingStatusResponse,
  type OnboardingStepResponse,
} from '@rizoma/contracts';
import type { ZodType } from 'zod';
import { newIdempotencyKey, requestJson } from './api-client.ts';

/** Base path of the setup controller (`@Controller('onboarding')`). */
const BASE = '/onboarding';

/** Reads one record; the API answers 404 with a typed envelope when absent. */
async function readOne<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
  const record = await requestJson(path, schema, signal === undefined ? {} : { signal });
  if (record === null) {
    // A 2xx with an empty body on these reads is a contract violation, not a
    // missing record; surfacing it as a failure is the honest behaviour.
    throw new Error(`El API respondió sin cuerpo para ${path}`);
  }
  return record;
}

/** `GET /v1/onboarding/status` — gate flag plus where the wizard stands. */
export function getOnboardingStatus(signal?: AbortSignal): Promise<OnboardingStatusResponse> {
  return readOne(`${BASE}/status`, onboardingStatusResponseSchema, signal);
}

/** `GET /v1/onboarding/resume` — the open case to reopen the wizard on. */
export function getOnboardingResume(signal?: AbortSignal): Promise<OnboardingStatusResponse> {
  return readOne(`${BASE}/resume`, onboardingStatusResponseSchema, signal);
}

/** `GET /v1/onboarding/acta` — the signed acta of the closed run. */
export function getOnboardingActa(signal?: AbortSignal): Promise<OnboardingActa> {
  return readOne(`${BASE}/acta`, onboardingActaSchema, signal);
}

/**
 * `POST /v1/onboarding/steps/:step` — confirms one wizard step.
 *
 * The payload is pre-flighted with the step schema, so a value the service
 * would refuse never costs a round trip. The key is fresh per *user intent*:
 * call it once per click and never inside a retry loop — collapsing the replay
 * (including the case open on step 1) is exactly what the key is for.
 */
export function submitOnboardingStep(
  step: number,
  data: unknown,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<OnboardingStepResponse> {
  const payload = onboardingStepInputSchema(step).parse(data);
  return postJson(`${BASE}/steps/${step}`, { data: payload }, onboardingStepResponseSchema, idempotencyKey);
}

/**
 * One JSON `POST` with a replay key and the endpoint's schema. Kept last so
 * the exported surface above reads as the endpoint list of the wizard.
 */
async function postJson<T>(
  path: string,
  body: unknown,
  schema: ZodType<T>,
  idempotencyKey: string,
): Promise<T> {
  const record = await requestJson(path, schema, {
    method: 'POST',
    body,
    idempotencyKey,
  });
  if (record === null) throw new Error(`El API respondió sin cuerpo para ${path}`);
  return record;
}
