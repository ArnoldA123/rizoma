// Triage + prescription contract tests — synthetic payloads only.
//
// Covers the H1 slice of `salud.ts`: the insert-only triage shapes and the
// template-based prescription shapes (bases-consolidadas-v1.md §2.3). Runner:
// `node --test src/salud-triage-prescription.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRESCRIPTION_STATUSES,
  prescriptionCreateInputSchema,
  prescriptionItemSchema,
  prescriptionListSchema,
  prescriptionRecordSchema,
  prescriptionStatusSchema,
  triageCreateInputSchema,
  triageListSchema,
  triageRecordSchema,
} from './salud.ts';

/** Synthetic identifiers — demo data, never production values. */
const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const EPISODE = '77777777-7777-4777-8777-777777777777';
const USER = '66666666-6666-4666-8666-666666666666';
const TRIAGE = '55555555-5555-4555-8555-555555555555';
const PRESCRIPTION = '99999999-9999-4999-8999-999999999999';

test('triage record accepts a row with and without an episode', () => {
  const withEpisode = triageRecordSchema.parse({
    id: TRIAGE,
    tenantId: TENANT,
    patientId: PATIENT,
    episodeId: EPISODE,
    recordedBy: USER,
    values: { systolic: 120, diastolic: 80 },
    at: '2026-09-25T10:00:00.000Z',
  });
  assert.equal(withEpisode.episodeId, EPISODE);

  const standalone = triageRecordSchema.parse({
    id: TRIAGE,
    tenantId: TENANT,
    patientId: PATIENT,
    episodeId: null,
    recordedBy: USER,
    values: { heartRate: 72 },
    at: null,
  });
  assert.equal(standalone.episodeId, null);
  assert.equal(standalone.at, null);
});

test('triage create body requires a patient and a non-empty values bag', () => {
  const valid = {
    patientId: PATIENT,
    episodeId: EPISODE,
    values: { systolic: 120 },
    at: '2026-09-25T10:00:00.000Z',
  };
  assert.equal(triageCreateInputSchema.safeParse(valid).success, true);
  assert.equal(
    triageCreateInputSchema.safeParse({ patientId: PATIENT, values: { heartRate: 72 } }).success,
    true,
    'episode and at are optional',
  );
  assert.equal(
    triageCreateInputSchema.safeParse({ patientId: PATIENT, values: {} }).success,
    false,
    'an empty values bag is refused',
  );
  assert.equal(
    triageCreateInputSchema.safeParse({ patientId: 'not-a-uuid', values: { x: 1 } }).success,
    false,
  );
  assert.equal(
    triageCreateInputSchema.safeParse({ patientId: PATIENT, values: { x: 1 }, at: 'ayer' }).success,
    false,
  );
});

test('triage list accepts the array the API returns and refuses an envelope', () => {
  assert.equal(triageListSchema.safeParse([]).success, true);
  assert.equal(triageListSchema.safeParse({ rows: [] }).success, false);
});

test('prescription status catalog matches the CHECK of migration 003', () => {
  assert.deepEqual([...PRESCRIPTION_STATUSES], ['draft', 'issued', 'cancelled']);
  assert.equal(prescriptionStatusSchema.safeParse('draft').success, true);
  assert.equal(prescriptionStatusSchema.safeParse('issued').success, true);
  assert.equal(prescriptionStatusSchema.safeParse('signed').success, false);
});

test('prescription item needs a description; the rest is optional detail', () => {
  assert.equal(
    prescriptionItemSchema.safeParse({ description: 'Amoxicilina 500 mg' }).success,
    true,
  );
  assert.equal(
    prescriptionItemSchema.safeParse({
      description: 'Amoxicilina 500 mg',
      quantity: 21,
      dose: '500 mg',
      frequency: 'cada 8 horas',
    }).success,
    true,
  );
  assert.equal(prescriptionItemSchema.safeParse({ description: '  ' }).success, false);
  assert.equal(prescriptionItemSchema.safeParse({ description: 'x', quantity: 0 }).success, false);
  assert.equal(
    prescriptionItemSchema.safeParse({ description: 'x', quantity: 1.5 }).success,
    false,
  );
});

test('prescription record carries episode, template, items and status', () => {
  const parsed = prescriptionRecordSchema.parse({
    id: PRESCRIPTION,
    tenantId: TENANT,
    patientId: PATIENT,
    episodeId: EPISODE,
    templateCode: 'receta.general',
    items: [{ description: 'Amoxicilina 500 mg', quantity: 21 }],
    status: 'draft',
  });
  assert.equal(parsed.episodeId, EPISODE);
  assert.equal(parsed.items.length, 1);
});

test('prescription create body derives the patient from the episode', () => {
  const parsed = prescriptionCreateInputSchema.parse({
    episodeId: EPISODE,
    templateCode: 'receta.general',
    items: [{ description: 'Amoxicilina 500 mg' }],
  });
  assert.equal(parsed.episodeId, EPISODE);
  assert.equal(parsed.status, undefined, 'omitted status means draft server-side');
  assert.equal(Object.hasOwn(parsed, 'patientId'), false);

  assert.equal(
    prescriptionCreateInputSchema.safeParse({
      episodeId: EPISODE,
      templateCode: 'receta.general',
      items: [],
    }).success,
    false,
    'an empty order is refused',
  );
  assert.equal(
    prescriptionCreateInputSchema.safeParse({
      episodeId: EPISODE,
      templateCode: '',
      items: [{ description: 'x' }],
    }).success,
    false,
  );
  assert.equal(
    prescriptionCreateInputSchema.safeParse({
      episodeId: EPISODE,
      templateCode: 'receta.general',
      items: [{ description: 'x' }],
      status: 'pending',
    }).success,
    false,
  );
});

test('prescription list accepts the array the API returns', () => {
  assert.equal(prescriptionListSchema.safeParse([]).success, true);
  assert.equal(prescriptionListSchema.safeParse({ rows: [] }).success, false);
});
