// Salud selector tests — the client-side filtering and paging rules, plus the
// invoice-line rule the caja form relies on.
//
// Every Salud list endpoint answers the whole scope capped at 200 rows and takes
// no filter parameter, so the screens filter and paginate in the browser. These
// pure functions are that decision in one place; if the agenda, the patient list
// and the ficha stop agreeing, these are the tests that fail first.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkQuantityField,
  checkUnitPriceField,
  firstIssue,
  type AppointmentRecord,
  type EpisodeRecord,
  type InvoiceRecord,
} from '@rizoma/contracts';
import {
  PAGE_SIZE,
  agendaViewFor,
  appointmentsOfPatient,
  appointmentsOfProfessional,
  appointmentsOnSedeDate,
  appointmentsOnUtcDate,
  episodesOfPatient,
  mergeInvoice,
  paginate,
  sedeDaysOf,
  statusCounts,
  utcDaysOf,
} from '../lib/salud-select.ts';
import {
  currentSedeDate,
  formatSedeStamp,
  isCurrentSedeDate,
  normalizeSedeTimezone,
  resolveSedeTimezone,
  sedeDateOf,
  sedeTimeOf,
} from '../lib/salud-time.ts';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const DOC_A = '55555555-5555-4555-8555-555555555555';
const DOC_B = '66666666-6666-4666-8666-666666666666';

function episode(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    tenantId: TENANT,
    patientId: PATIENT_A,
    specialty: 'medicina general',
    professionalId: '77777777-7777-4777-8777-777777777777',
    openedAt: '2026-09-01T10:00:00.000Z',
    closedAt: null,
    status: 'open',
    ...overrides,
  };
}

function appointment(overrides: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    tenantId: TENANT,
    orgNodeId: ORG,
    patientId: PATIENT_A,
    professionalId: '77777777-7777-4777-8777-777777777777',
    startsAt: '2026-09-25T15:00:00.000Z',
    durationMin: 20,
    status: 'scheduled',
    createdAt: '2026-09-20T09:00:00.000Z',
    ...overrides,
  };
}

function invoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: DOC_A,
    tenantId: TENANT,
    orgNodeId: ORG,
    quoteId: null,
    serie: 'F001',
    numero: 1,
    customerDocType: 'dni',
    customerDocNumber: '12345678',
    customerName: 'Cliente sintético',
    items: [],
    subtotal: 100,
    igvRate: 0.18,
    igvTotal: 18,
    total: 118,
    status: 'issued',
    fiscalStatus: 'pending',
    fiscalAdapter: 'none',
    fiscalPayload: {},
    cashSessionId: null,
    issuedAt: '2026-09-25T16:00:00.000Z',
    createdAt: '2026-09-25T16:00:00.000Z',
    ...overrides,
  };
}

test('agendaViewFor: recepción programa, médico enfoca, el resto lee', () => {
  assert.equal(agendaViewFor('recepcion'), 'recepcion');
  assert.equal(agendaViewFor('medico'), 'medico');
  assert.equal(agendaViewFor('enfermeria'), 'lectura');
  assert.equal(agendaViewFor('auditor'), 'lectura');
  assert.equal(agendaViewFor(null), 'lectura');
});

test('paginate: acota la página pedida y calcula los contadores 1-based', () => {
  const rows = Array.from({ length: 25 }, (_, index) => index + 1);
  const first = paginate(rows, 1);
  assert.equal(PAGE_SIZE, 10);
  assert.deepEqual(first.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(
    { page: first.page, pageCount: first.pageCount, total: first.total, from: first.from, to: first.to },
    { page: 1, pageCount: 3, total: 25, from: 1, to: 10 },
  );

  const last = paginate(rows, 3);
  assert.deepEqual(last.items, [21, 22, 23, 24, 25]);
  assert.deepEqual({ from: last.from, to: last.to }, { from: 21, to: 25 });

  // Out-of-range requests clamp instead of returning an empty page.
  assert.equal(paginate(rows, 99).page, 3);
  assert.equal(paginate(rows, 0).page, 1);
  assert.equal(paginate(rows, -4).page, 1);

  const empty = paginate([], 1);
  assert.deepEqual(empty.items, []);
  assert.deepEqual({ pageCount: empty.pageCount, from: empty.from, to: empty.to }, { pageCount: 1, from: 0, to: 0 });
});

test('selectores: ficha y agenda filtran por paciente y por profesional', () => {
  const episodes = [
    episode({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }),
    episode({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', patientId: PATIENT_B }),
  ];
  assert.deepEqual(
    episodesOfPatient(episodes, PATIENT_A).map((row) => row.id),
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
  );

  const appointments = [
    appointment({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' }),
    appointment({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', patientId: PATIENT_B }),
    appointment({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
      professionalId: '88888888-8888-4888-8888-888888888888',
    }),
  ];
  assert.equal(appointmentsOfPatient(appointments, PATIENT_A).length, 2);

  // An unresolved professional keeps the whole list: the focus is a view, never
  // an authorisation, so it must not silently empty a legitimate agenda.
  assert.equal(appointmentsOfProfessional(appointments, null).length, 3);
  assert.equal(appointmentsOfProfessional(appointments, '').length, 3);
  assert.deepEqual(
    appointmentsOfProfessional(appointments, '77777777-7777-4777-8777-777777777777').map(
      (row) => row.id,
    ),
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'],
  );
});

test('appointmentsOnUtcDate: agrupa por día UTC y ordena por hora de inicio', () => {
  const rows = [
    appointment({ id: 'c1', startsAt: '2026-09-25T20:30:00.000Z' }),
    appointment({ id: 'c2', startsAt: '2026-09-25T13:05:00.000Z' }),
    // 23:30 in Lima is already the next UTC day: the day filter is UTC, which is
    // what makes this screen agree with the dashboard `?date=`.
    appointment({ id: 'c3', startsAt: '2026-09-26T04:30:00.000Z' }),
    appointment({ id: 'c4', startsAt: null }),
  ];
  assert.deepEqual(
    appointmentsOnUtcDate(rows, '2026-09-25').map((row) => row.id),
    ['c2', 'c1'],
  );
  assert.deepEqual(
    appointmentsOnUtcDate(rows, '2026-09-26').map((row) => row.id),
    ['c3'],
  );

  const counts = statusCounts(rows);
  assert.deepEqual(counts, { scheduled: 4, confirmed: 0, checked_in: 0, in_care: 0, completed: 0, no_show: 0, cancelled: 0, derived: 0 });
  assert.equal(statusCounts([appointment({ status: '' })]).scheduled, 1);

  assert.deepEqual(utcDaysOf(rows), ['2026-09-25', '2026-09-26']);
});

test('día de la sede: el borde UTC vs Lima agrupa por la zona de la sede', () => {
  const rows = [
    appointment({ id: 'c1', startsAt: '2026-09-25T20:30:00.000Z' }),
    appointment({ id: 'c2', startsAt: '2026-09-25T13:05:00.000Z' }),
    // 23:30 in Lima is already the next UTC day: the sede grouping keeps it
    // on the 25th, while the legacy UTC grouping reads the 26th.
    appointment({ id: 'c3', startsAt: '2026-09-26T04:30:00.000Z' }),
    appointment({ id: 'c4', startsAt: null }),
  ];
  const LIMA = 'America/Lima';

  assert.equal(sedeDateOf('2026-09-26T04:30:00.000Z', LIMA), '2026-09-25');
  assert.equal(sedeDateOf('2026-09-26T04:30:00.000Z', 'UTC'), '2026-09-26');
  assert.equal(sedeDateOf(null, LIMA), null);
  // No zone given means the Lima fallback, never a throw.
  assert.equal(sedeDateOf('2026-09-26T04:30:00.000Z'), '2026-09-25');

  assert.deepEqual(
    appointmentsOnSedeDate(rows, '2026-09-25', LIMA).map((row) => row.id),
    ['c2', 'c1', 'c3'],
  );
  assert.deepEqual(appointmentsOnSedeDate(rows, '2026-09-26', LIMA), []);
  assert.deepEqual(
    appointmentsOnSedeDate(rows, '2026-09-26', 'UTC').map((row) => row.id),
    ['c3'],
  );
  assert.deepEqual(sedeDaysOf(rows, LIMA), ['2026-09-25']);
  assert.deepEqual(sedeDaysOf(rows, 'UTC'), ['2026-09-25', '2026-09-26']);

  // "Hoy" is the sede day: the same instant is the 25th in Lima.
  const now = new Date('2026-09-26T04:30:00.000Z');
  assert.equal(currentSedeDate(LIMA, now), '2026-09-25');
  assert.equal(currentSedeDate('UTC', now), '2026-09-26');
  assert.equal(isCurrentSedeDate('2026-09-25', LIMA, now), true);
  assert.equal(isCurrentSedeDate('2026-09-26', LIMA, now), false);

  // Hours read in the sede zone: 04:30 UTC is 23:30 in Lima.
  assert.equal(sedeTimeOf('2026-09-26T04:30:00.000Z', LIMA), '23:30');
  assert.equal(sedeTimeOf(null, LIMA), '—');

  // The stamp carries no zone suffix: the hour on screen is the sede's.
  const stamp = formatSedeStamp('2026-09-26T04:30:00.000Z', LIMA);
  assert.match(stamp, /23:30/);
  assert.doesNotMatch(stamp, /\(UTC\)/);
  assert.equal(formatSedeStamp(null, LIMA), '—');
});

test('zona de la sede: la sede viaja como parámetro con respaldo Lima', () => {
  const nodes = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      parentId: null,
      kind: 'sede',
      name: 'Sede Lima',
      active: true,
      timezone: 'America/Lima',
    },
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      parentId: null,
      kind: 'sede',
      name: 'Sede sin zona',
      active: true,
    },
  ];
  assert.equal(
    resolveSedeTimezone(nodes, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
    'America/Lima',
  );
  // A row with no zone reads as Lima, never as an empty string.
  assert.equal(
    resolveSedeTimezone(nodes, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
    'America/Lima',
  );
  // An unknown id falls back to the first node; no nodes means Lima.
  assert.equal(resolveSedeTimezone(nodes, 'desconocida'), 'America/Lima');
  assert.equal(resolveSedeTimezone([]), 'America/Lima');
  assert.equal(normalizeSedeTimezone('Bogotá no es zona'), 'America/Lima');
  assert.equal(normalizeSedeTimezone(null), 'America/Lima');
});

test('mergeInvoice: reemplaza en el sitio y antepone lo nuevo sin duplicar', () => {
  const first = invoice({ id: DOC_A, numero: 1 });
  const second = invoice({ id: DOC_B, numero: 2 });
  const list = [first, second];

  // A payment answers the updated invoice: the row is replaced where it was, so
  // the session list keeps the order the operator saw.
  const paid = invoice({ id: DOC_B, numero: 2, status: 'paid', fiscalStatus: 'accepted' });
  const afterPay = mergeInvoice(list, paid);
  assert.deepEqual(
    afterPay.map((row) => [row.id, row.status]),
    [
      [DOC_A, 'issued'],
      [DOC_B, 'paid'],
    ],
  );
  assert.equal(afterPay.length, 2);

  // A fresh issue has no row yet and goes on top.
  const third = invoice({ id: '99999999-9999-4999-8999-999999999999', numero: 3 });
  const afterIssue = mergeInvoice(list, third);
  assert.deepEqual(
    afterIssue.map((row) => row.numero),
    [3, 1, 2],
  );

  // The caller's list is never mutated: the merge returns a new array.
  assert.deepEqual(list.map((row) => row.id), [DOC_A, DOC_B]);
  assert.notEqual(afterPay, list);
});

test('líneas de comprobante: cantidad positiva y precio unitario no negativo', () => {
  // The rule the invoice form applies per line, keyed by its index so the verdict
  // lands on the row that carries the mistake.
  assert.equal(checkQuantityField('items[0].quantity', '1'), null);
  assert.equal(checkQuantityField('items[0].quantity', '2.5'), null);
  assert.equal(checkUnitPriceField('items[0].unitPrice', '0'), null);
  assert.equal(checkUnitPriceField('items[0].unitPrice', '19.9'), null);

  // A quantity is strictly positive; an empty one is a missing value, not an
  // out-of-range one, which is why the two codes differ.
  assert.equal(checkQuantityField('items[1].quantity', '0')?.code, 'invalid_amount');
  assert.equal(checkQuantityField('items[1].quantity', '-3')?.code, 'invalid_amount');
  assert.equal(checkQuantityField('items[1].quantity', 'dos')?.code, 'invalid_amount');
  assert.equal(checkQuantityField('items[1].quantity', '')?.code, 'required');

  // A unit price may be zero (a courtesy line) but never negative or malformed.
  assert.equal(checkUnitPriceField('items[1].unitPrice', '-1')?.code, 'invalid_amount');
  assert.equal(checkUnitPriceField('items[1].unitPrice', 'x')?.code, 'invalid_amount');
  assert.equal(checkUnitPriceField('items[1].unitPrice', '')?.code, 'required');

  // Each verdict carries the indexed field path, and `firstIssue` reports the
  // first blocked row in insertion order — the order the form renders its lines.
  const issue = firstIssue({
    'items[0].description': null,
    'items[0].quantity': checkQuantityField('items[0].quantity', '0'),
    'items[1].quantity': checkQuantityField('items[1].quantity', '0'),
  });
  assert.equal(issue?.field, 'items[0].quantity');
  assert.equal(firstIssue({ 'items[0].quantity': null }), null);
});
