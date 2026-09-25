// API key contracts — `POST/GET /v1/api-keys` (W1).
//
// Machine auth for tenant integrations: the secret travels in the `X-Api-Key`
// header, the API stores only its SHA-256 digest, and the create endpoint
// returns the secret exactly once. The list/revoke shapes therefore never carry
// it — a payload with a `secret` field where none belongs fails validation.
// Runner: `node --test src/api-keys.test.ts` (type stripping).
import { z } from 'zod';
import { isoValueSchema, uuidSchema } from './common.ts';

/** Request header carrying the opaque API key secret. */
export const API_KEY_HEADER = 'x-api-key';

/** Public prefix of an issued secret, e.g. `rizoma_...` (identification only). */
export const API_KEY_SECRET_PREFIX = 'rizoma_';

/** `POST /v1/api-keys` — issue one key for the caller tenant. */
export const apiKeyCreateInputSchema = z.object({
  /** Operator label (`CI / facturación`, `ETL nocturno`); never the secret. */
  name: z.string().min(1).max(120),
  /** OAuth-style scopes the key grants; empty means no scope. */
  scopes: z.array(z.string().min(1).max(64)).default([]),
  /** Optional expiry (offset-aware ISO-8601); `null`/absent means no expiry. */
  validTo: isoValueSchema.optional(),
});

export type ApiKeyCreateInput = z.input<typeof apiKeyCreateInputSchema>;

/** One key as `GET /v1/api-keys` lists it — identification only, no secret. */
export const apiKeyRecordSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  name: z.string(),
  /** Short public identifier so operators know WHICH key a row is. */
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  active: z.boolean(),
  validFrom: isoValueSchema,
  validTo: isoValueSchema,
  createdAt: isoValueSchema,
});

export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;

/**
 * `POST /v1/api-keys` answer: the record plus the secret, exactly once.
 * The service never returns `secret` again (list/revoke carry no secret).
 */
export const apiKeyCreateResponseSchema = apiKeyRecordSchema.extend({
  /** Opaque secret (`rizoma_...`); shown once, stored only as SHA-256. */
  secret: z.string().min(1),
});

export type ApiKeyCreateResponse = z.infer<typeof apiKeyCreateResponseSchema>;

/** `GET /v1/api-keys` — newest first, capped by the service. */
export const apiKeyListSchema = z.array(apiKeyRecordSchema);

export type ApiKeyList = z.infer<typeof apiKeyListSchema>;
