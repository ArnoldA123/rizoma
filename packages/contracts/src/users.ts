// Users contracts — row shapes of `apps/api/src/users/users.service.ts`.
//
// The personnel listing (`users` joined with `memberships`) backs the P2
// person selectors. Privacy rule, mirrored from the service: the shape carries
// only what a selector renders (`id`, `name`, `email`) plus the assignment
// context (`orgNodeId`, `role`, `active`). It never carries `phone` or
// `mfa_enrolled` — those columns exist in `001_core_foundation.sql` but no
// listing may select them.
import { z } from 'zod';
import { uuidSchema } from './common.ts';
import { pagedListSchema, paginationQuerySchema } from './pagination.ts';

/** `GET /v1/users` — one person with their active membership context. */
export const userRecordSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  email: z.string().email(),
  /** Org node of the active membership the row was joined through. */
  orgNodeId: uuidSchema,
  /** Membership role (a realm role code, e.g. `medico`). */
  role: z.string(),
  /** `users.active` — `false` marks a deactivated person. */
  active: z.boolean(),
});

export type UserRecord = z.infer<typeof userRecordSchema>;

/**
 * `GET /v1/users` — bare array capped at 200 (legacy path, no cursor),
 * newest first (`created_at DESC, id DESC`).
 */
export const userListSchema = z.array(userRecordSchema);
export type UserList = z.infer<typeof userListSchema>;

/**
 * Query filters of `GET /v1/users`, field-for-field what the service parser
 * accepts: the membership org node, the membership role and the activation
 * flag. Every field is optional and an empty string counts as absent.
 */
export const userListQuerySchema = z.object({
  orgNodeId: uuidSchema.nullable().optional(),
  role: z.string().min(1).nullable().optional(),
  active: z.boolean().nullable().optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

/** Keyset query (`?cursor=` / `?limit=`) shared with every R1 listing. */
export const userPageQuerySchema = paginationQuerySchema;
export type UserPageQuery = z.infer<typeof userPageQuerySchema>;

/** Keyset page of `GET /v1/users` (`{rows, nextCursor}`). */
export const userPagedSchema = pagedListSchema(userRecordSchema);
export type UserPaged = z.infer<typeof userPagedSchema>;
