// Custom-field contracts — `POST/GET/PATCH /v1/custom-fields` (B2).
//
// A custom field definition types one extra key of an existing JSONB bag:
// `patient_files.contacts` (`module: 'salud'`, `entity: 'patient'`) or
// `triages.values` (`module: 'salud'`, `entity: 'triage'`). The table
// (`db/migrations/001_core_foundation.sql`, `custom_field_defs`) carries the
// rows; this module carries the shapes both sides validate against.
//
// Scope is deliberately narrow: typed primitives only
// (`text|number|date|boolean`) plus `required`. No computed fields, no
// relations, no fully dynamic UI — the two existing forms render one input per
// active definition, keyed by `code`, and the API re-validates every write.
//
// Runner: `node --test src/custom-fields.test.ts` (type stripping).
// NOTE: expose through the package entry point with one line in
// `packages/contracts/src/index.ts`:
//   export * from './custom-fields.ts';
import { z } from 'zod';
import { uuidSchema } from './common.ts';

/** Value types a definition may declare — primitives only, no relations. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'boolean'] as const;
export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

/** Lifecycle of a definition, mirroring the table CHECK. */
export const CUSTOM_FIELD_STATUSES = ['draft', 'active', 'retired'] as const;
export const customFieldStatusSchema = z.enum(CUSTOM_FIELD_STATUSES);
export type CustomFieldStatus = z.infer<typeof customFieldStatusSchema>;

/**
 * Bindings of this slice: which `(module, entity)` pair types which JSONB
 * bag. The service enforces values only for `active` definitions of these
 * pairs; any other pair is storable and listable but enforced nowhere.
 */
export const CUSTOM_FIELD_MODULE_SALUD = 'salud';
export const CUSTOM_FIELD_ENTITY_PATIENT = 'patient';
export const CUSTOM_FIELD_ENTITY_TRIAGE = 'triage';

/** `code` shape: `camelCase`/`snake_case` identifier, so it maps 1:1 to a bag key. */
export const CUSTOM_FIELD_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** `module`/`entity` shape: short namespace identifier, never free text. */
export const CUSTOM_FIELD_SCOPE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Field key of one definition (`code` of the JSONB bag). */
export const customFieldCodeSchema = z
  .string()
  .regex(CUSTOM_FIELD_CODE_RE, 'code must be a camelCase/snake_case identifier (max 64)');

/** `module`/`entity` namespace of one definition. */
export const customFieldScopeSchema = z
  .string()
  .regex(CUSTOM_FIELD_SCOPE_RE, 'module/entity must be a short identifier (max 64)');

/** One definition as the API returns it. */
export const customFieldDefSchema = z.object({
  id: uuidSchema,
  tenantId: uuidSchema,
  module: customFieldScopeSchema,
  entity: customFieldScopeSchema,
  code: customFieldCodeSchema,
  type: customFieldTypeSchema,
  required: z.boolean(),
  status: customFieldStatusSchema,
});

export type CustomFieldDef = z.infer<typeof customFieldDefSchema>;

/** `GET /v1/custom-fields` — tenant-scoped definitions, ordered by `code`. */
export const customFieldListSchema = z.array(customFieldDefSchema);
export type CustomFieldList = z.infer<typeof customFieldListSchema>;

/** Body of `POST /v1/custom-fields` — `required` defaults to `false`, `status` to `draft`. */
export const customFieldCreateInputSchema = z.object({
  module: customFieldScopeSchema,
  entity: customFieldScopeSchema,
  code: customFieldCodeSchema,
  type: customFieldTypeSchema,
  required: z.boolean().default(false),
  status: customFieldStatusSchema.default('draft'),
});
export type CustomFieldCreateInput = z.input<typeof customFieldCreateInputSchema>;

/**
 * Body of `PATCH /v1/custom-fields/:id` — at least one field is required.
 * `module`/`entity`/`code` are immutable: they are the unique key
 * (`tenant/module/entity/code`), so a rename is delete (retire) + create.
 */
export const customFieldUpdateInputSchema = z
  .object({
    type: customFieldTypeSchema.optional(),
    required: z.boolean().optional(),
    status: customFieldStatusSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.type === undefined &&
      input.required === undefined &&
      input.status === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Body must include at least one of type, required or status',
      });
    }
  });
export type CustomFieldUpdateInput = z.input<typeof customFieldUpdateInputSchema>;

/** Query of `GET /v1/custom-fields` — every filter optional, nothing else. */
export interface CustomFieldsQuery {
  readonly module?: string;
  readonly entity?: string;
  readonly status?: string;
}

/**
 * Query string of `GET /v1/custom-fields`, `?` included and empty fields
 * omitted. Unknown values are *not* defaulted here: the API answers 400, so a
 * typo is loud instead of silently listing everything.
 */
export function customFieldsQueryString(query: CustomFieldsQuery = {}): string {
  const params = new URLSearchParams();
  if (query.module !== undefined && query.module !== '') params.set('module', query.module);
  if (query.entity !== undefined && query.entity !== '') params.set('entity', query.entity);
  if (query.status !== undefined && query.status !== '') params.set('status', query.status);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
