// Custom-field contract tests — synthetic payloads only, no live API involved.
//
// These tests protect the B2 shapes: the definition record the API row mapper
// emits, the create/update bodies the service parsers accept, and the query
// helper the management screens use. Runner:
// `node --test src/custom-fields.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CUSTOM_FIELD_ENTITY_PATIENT,
  CUSTOM_FIELD_ENTITY_TRIAGE,
  CUSTOM_FIELD_MODULE_SALUD,
  CUSTOM_FIELD_STATUSES,
  CUSTOM_FIELD_TYPES,
  customFieldCreateInputSchema,
  customFieldDefSchema,
  customFieldListSchema,
  customFieldUpdateInputSchema,
  customFieldsQueryString,
} from './custom-fields.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DEF = '33333333-3333-4333-8333-333333333333';

test('definition record accepts the API row shape', () => {
  const parsed = customFieldDefSchema.parse({
    id: DEF,
    tenantId: TENANT,
    module: 'salud',
    entity: 'patient',
    code: 'healthInsurance',
    type: 'text',
    required: true,
    status: 'active',
  });
  assert.equal(parsed.code, 'healthInsurance');
  assert.equal(parsed.required, true);
});

test('definition record refuses an unknown type and a bad code', () => {
  const base = {
    id: DEF,
    tenantId: TENANT,
    module: 'salud',
    entity: 'patient',
    code: 'healthInsurance',
    type: 'text',
    required: false,
    status: 'draft',
  };
  assert.equal(customFieldDefSchema.safeParse({ ...base, type: 'relation' }).success, false);
  assert.equal(customFieldDefSchema.safeParse({ ...base, code: '9lives' }).success, false);
  assert.equal(customFieldDefSchema.safeParse({ ...base, status: 'archived' }).success, false);
});

test('salud bindings name the two JSONB bags of this slice', () => {
  assert.equal(CUSTOM_FIELD_MODULE_SALUD, 'salud');
  assert.equal(CUSTOM_FIELD_ENTITY_PATIENT, 'patient');
  assert.equal(CUSTOM_FIELD_ENTITY_TRIAGE, 'triage');
  assert.deepEqual([...CUSTOM_FIELD_TYPES], ['text', 'number', 'date', 'boolean']);
  assert.deepEqual([...CUSTOM_FIELD_STATUSES], ['draft', 'active', 'retired']);
});

test('create body applies the parser defaults and refuses a bad payload', () => {
  const parsed = customFieldCreateInputSchema.parse({
    module: 'salud',
    entity: 'triage',
    code: 'painScale',
    type: 'number',
  });
  // The API stores `required = FALSE, status = 'draft'` when absent, so the mirror does too.
  assert.equal(parsed.required, false);
  assert.equal(parsed.status, 'draft');

  assert.equal(
    customFieldCreateInputSchema.safeParse({
      module: 'salud',
      entity: 'patient',
      code: 'ok_code',
      type: 'computed',
    }).success,
    false,
  );
  assert.equal(
    customFieldCreateInputSchema.safeParse({
      module: 'salud!',
      entity: 'patient',
      code: 'ok_code',
      type: 'text',
    }).success,
    false,
  );
});

test('update body needs at least one field and keeps the key immutable', () => {
  assert.equal(customFieldUpdateInputSchema.safeParse({}).success, false);
  assert.equal(
    customFieldUpdateInputSchema.safeParse({ status: 'retired' }).success,
    true,
  );
  // `module`/`entity`/`code` are the unique key: a rename travels as retire +
  // create, so the schema has no room for them (strips unknown keys instead).
  const parsed = customFieldUpdateInputSchema.parse({
    required: true,
    module: 'other',
  } as unknown);
  assert.equal(Object.hasOwn(parsed, 'module'), false);
});

test('list envelope accepts the array the API returns', () => {
  assert.equal(customFieldListSchema.safeParse([]).success, true);
  assert.equal(customFieldListSchema.safeParse({ rows: [] }).success, false);
});

test('query string omits empty fields and keeps module before entity', () => {
  assert.equal(customFieldsQueryString(), '');
  assert.equal(customFieldsQueryString({ module: 'salud' }), '?module=salud');
  assert.equal(
    customFieldsQueryString({ module: 'salud', entity: 'patient', status: 'active' }),
    '?module=salud&entity=patient&status=active',
  );
  assert.equal(customFieldsQueryString({ status: '' }), '');
});
