// Contract tests — synthetic payloads only, no live API involved.
//
// These tests protect two things: the schemas accept the exact shapes the API
// row mappers emit, and the negative security properties of the contract stay
// true (the caja board carries no clinical field, the medico board carries no
// amount). Runner: `node --test src/contracts.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { InvoiceRecord, PaymentRecord } from './index.ts';

import {
  apiErrorSchema,
  appointmentCreateInputSchema,
  appointmentListSchema,
  appointmentRecordSchema,
  appointmentStatusSchema,
  assignmentCreateInputSchema,
  ATTENDANCE_STATUSES,
  attendanceMarkInputSchema,
  attendanceQueryString,
  attendanceRecordSchema,
  attendanceStatusSchema,
  billingLineSchema,
  boardRoleFor,
  BOARD_POLL_DEFAULT_MS,
  BOARD_POLL_MAX_MS,
  BOARD_POLL_MIN_MS,
  cajaBoardSchema,
  cashSessionCloseInputSchema,
  cashSessionOpenInputSchema,
  checkAmountField,
  checkAmountWithinPending,
  checkDateField,
  checkDateTimeField,
  checkDocumentNumberField,
  checkDocumentTypeField,
  checkDurationField,
  checkIgvRateField,
  checkNumberField,
  checkPositiveNumberField,
  checkInvoiceDocumentNumberField,
  checkOptionalAmountField,
  checkQuantityField,
  checkRequiredText,
  checkSerieField,
  checkSha256Field,
  checkUnitPriceField,
  checkUuidField,
  clampBoardPollMs,
  clampObrasBoardPollMs,
  companyBoardSchema,
  CONSENT_RECORD_TYPES,
  consentCreateInputSchema,
  consentListSchema,
  consentRecordSchema,
  draftIsClean,
  documentTypeSchema,
  episodeCreateInputSchema,
  episodeListSchema,
  FISCAL_STATUSES,
  firstIssue,
  importJobIsClean,
  importJobRecordSchema,
  INVOICE_STATUSES,
  invoiceIssueInputSchema,
  invoiceRecordSchema,
  invoicePayInputSchema,
  invoiceVoidInputSchema,
  invoiceWithFiscalSchema,
  isRealUtcDate,
  medicoBoardSchema,
  patientCreateInputSchema,
  patientListSchema,
  patientRecordSchema,
  patientsImportInputSchema,
  PATIENTS_CSV_REQUIRED_COLUMNS,
  OBRAS_BOARD_POLL_DEFAULT_MS,
  OBRAS_BOARD_POLL_MAX_MS,
  OBRAS_BOARD_POLL_MIN_MS,
  paymentRecordSchema,
  pendingInvoiceTotal,
  quoteCreateInputSchema,
  quoteListSchema,
  RECORDING_SCOPE_ALL,
  recepcionBoardSchema,
  registeredPaidTotal,
  round2,
  saludBoardQueryString,
  siteBoardSchema,
  siteBoardQueryString,
  siteCreateInputSchema,
  siteLogCreateInputSchema,
  siteLogIsDraft,
  siteLogListSchema,
  siteLogRecordSchema,
  siteRecordSchema,
  siteStaffRecordSchema,
  SITE_LOG_STATUSES,
  SITE_STATUSES,
  siteStatusSchema,
  stockMoveInputSchema,
  stockMoveKindSchema,
  stockMoveRecordSchema,
  stockMoveSignedQty,
  STOCK_MOVE_KINDS,
  STOCK_MOVE_STATUSES,
  uuidSchema,
  WORKERS_CSV_COLUMNS,
  WORKERS_CSV_REQUIRED_COLUMNS,
  workersImportInputSchema,
  ASSETS_CSV_COLUMNS,
  ASSETS_CSV_REQUIRED_COLUMNS,
  ASSET_STATUSES,
  assetCanBeAssigned,
  assetCanBeRead,
  assetReadingInputSchema,
  assetReadingRecordSchema,
  assetRecordSchema,
  assetsImportInputSchema,
  budgetLineCreateInputSchema,
  CONSTRUCTION_ROLES,
  inventoryItemRecordSchema,
  itemCreateInputSchema,
  milestoneCreateInputSchema,
  milestoneRecordSchema,
  MILESTONE_STATUSES,
  OBRAS_IMPORT_KINDS,
  progressEntriesQueryString,
  progressEntryCreateInputSchema,
  progressEntryListSchema,
  progressEntryRecordSchema,
} from './index.ts';

/** Synthetic tenant/sede identifiers — demo data, never production values. */
const TENANT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';

test('patient record accepts the API row shape', () => {
  const parsed = patientRecordSchema.parse({
    id: PATIENT,
    tenantId: TENANT,
    orgNodeId: ORG,
    personName: 'Paciente Demo Uno',
    documentType: 'DNI',
    documentNumber: '00000001',
    birthdate: '1990-01-31',
    allergies: ['penicilina'],
    alerts: [],
    contacts: { phone: '+51000000001' },
    active: true,
    createdAt: '2026-09-25T10:00:00.000Z',
  });
  assert.equal(parsed.personName, 'Paciente Demo Uno');
  assert.equal(parsed.birthdate, '1990-01-31');
});

test('patient record rejects a non-UUID identifier', () => {
  const result = patientRecordSchema.safeParse({
    id: 'not-a-uuid',
    tenantId: TENANT,
    orgNodeId: ORG,
    personName: 'Paciente Demo Dos',
    documentType: 'DNI',
    documentNumber: '00000002',
    birthdate: null,
    allergies: [],
    alerts: [],
    contacts: {},
    active: false,
    createdAt: null,
  });
  assert.equal(result.success, false);
});

test('appointment record keeps a null createdAt and a numeric duration', () => {
  const parsed = appointmentRecordSchema.parse({
    id: '55555555-5555-4555-8555-555555555555',
    tenantId: TENANT,
    orgNodeId: ORG,
    patientId: PATIENT,
    professionalId: '66666666-6666-4666-8666-666666666666',
    startsAt: '2026-09-25T15:30:00.000Z',
    durationMin: 20,
    status: 'scheduled',
    createdAt: null,
  });
  assert.equal(parsed.durationMin, 20);
  assert.equal(parsed.createdAt, null);
});

test('consent record carries the derived gate and recording marks', () => {
  const parsed = consentRecordSchema.parse({
    id: '77777777-7777-4777-8777-777777777777',
    tenantId: TENANT,
    patientId: PATIENT,
    templateCode: 'consent.pe.teleinterconsulta',
    templateVersion: '2025.1',
    versionKey: 'v1',
    episodeId: '88888888-8888-4888-8888-888888888888',
    consultingCenter: 'Sede Demo',
    consultorCenter: 'Centro Demo',
    informedBy: 'Dra. Demo',
    patientName: 'Paciente Demo Uno',
    docType: 'DNI',
    docNumber: '00000001',
    actConsent: 'SI',
    recording: { todo: 'SI', video: 'NO' },
    signedAt: '2026-09-25T16:00:00.000Z',
    evidenceAttachmentId: null,
    status: 'signed',
    canStartSession: true,
    allowedRecordingTypes: ['todo'],
  });
  assert.equal(parsed.canStartSession, true);
  assert.deepEqual(parsed.allowedRecordingTypes, ['todo']);
});

test('invoice with fiscal exposes the fiscal pair and the payments array', () => {
  const parsed = invoiceWithFiscalSchema.parse({
    id: '99999999-9999-4999-8999-999999999999',
    tenantId: TENANT,
    orgNodeId: ORG,
    quoteId: null,
    serie: 'F001',
    numero: 1,
    customerDocType: 'DNI',
    customerDocNumber: '00000001',
    customerName: 'Paciente Demo Uno',
    items: [{ description: 'Consulta', quantity: 1, unitPrice: 50 }],
    subtotal: 50,
    igvRate: 0.18,
    igvTotal: 9,
    total: 59,
    status: 'issued',
    fiscalStatus: 'pending',
    fiscalAdapter: 'manual_v1',
    fiscalPayload: {},
    cashSessionId: null,
    issuedAt: '2026-09-25T16:05:00.000Z',
    createdAt: '2026-09-25T16:05:00.000Z',
    payments: [],
  });
  assert.equal(parsed.fiscalStatus, 'pending');
  assert.equal(parsed.payments.length, 0);
});

test('site staff record extends the assignment with worker names', () => {
  const parsed = siteStaffRecordSchema.parse({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenantId: TENANT,
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    siteId: SITE,
    crewId: null,
    roleInSite: 'capataz',
    active: true,
    validFrom: '2026-09-01',
    validTo: null,
    userName: 'Trabajador Demo',
    crewName: null,
  });
  assert.equal(parsed.userName, 'Trabajador Demo');
});

test('site board accepts empty collections for a quiet day', () => {
  const parsed = siteBoardSchema.parse({
    siteId: SITE,
    siteCode: 'OB-001',
    orgNodeId: ORG,
    date: '2026-09-25',
    progress: [],
    attendance: { date: '2026-09-25', registered: 0, approved: 0, rejected: 0, adjusted: 0, total: 0 },
    criticalStock: [],
    maintenanceAssets: [],
    upcomingMilestones: [],
  });
  assert.equal(parsed.progress.length, 0);
  assert.equal(parsed.attendance.total, 0);
});

test('company board reports non-applicable KPIs instead of zeroes', () => {
  const parsed = companyBoardSchema.parse({
    orgNodeId: ORG,
    date: '2026-09-25',
    sites: { total: 3, active: 1, planned: 2, closed: 0 },
    progress: { qtyPlanned: 120, qtyDone: 40, qtyRemaining: 80, percent: 33.33 },
    notApplicable: { collections: 'no aplica a nivel empresa', moduleUsage: 'no aplica' },
  });
  assert.equal(parsed.notApplicable.collections, 'no aplica a nivel empresa');
});

test('salud boards are discriminated by role', () => {
  const recepcion = recepcionBoardSchema.safeParse({
    role: 'recepcion',
    orgNodeId: ORG,
    date: '2026-09-25',
    todayAppointments: 4,
    waitingAvgMin: 12,
    noShows: 1,
    queue: 2,
  });
  assert.equal(recepcion.success, true);

  const wrongRole = recepcionBoardSchema.safeParse({
    role: 'caja',
    orgNodeId: ORG,
    date: '2026-09-25',
    todayAppointments: 0,
    waitingAvgMin: 0,
    noShows: 0,
    queue: 0,
  });
  assert.equal(wrongRole.success, false);
});

test('caja board strips clinical fields a malicious payload could try to inject', () => {
  const parsed = cajaBoardSchema.parse({
    role: 'caja',
    orgNodeId: ORG,
    date: '2026-09-25',
    todayCollected: 118,
    invoicesIssued: 2,
    fiscalPending: 1,
    openSession: null,
    diagnosis: 'should never reach the caja board',
  } as unknown);
  assert.equal(Object.hasOwn(parsed, 'diagnosis'), false);
  assert.equal(Object.hasOwn(parsed, 'patientName'), false);
});

test('medico board carries counts only, never amounts', () => {
  const parsed = medicoBoardSchema.parse({
    role: 'medico',
    orgNodeId: ORG,
    date: '2026-09-25',
    myAppointments: 6,
    openEpisodes: 2,
    pendingConsents: 1,
    todayCollected: 999,
  } as unknown);
  assert.equal(Object.hasOwn(parsed, 'todayCollected'), false);
  assert.equal(Object.hasOwn(parsed, 'total'), false);
});

test('error envelope carries code, message, reason and traceId', () => {
  const parsed = apiErrorSchema.parse({
    code: 'access.denied',
    message: 'Access denied: role.denied',
    reason: 'role.denied',
    traceId: 'trace-demo-1',
  });
  assert.equal(parsed.reason, 'role.denied');
  assert.equal(parsed.traceId, 'trace-demo-1');
});

test('site record and uuid schema reject malformed input', () => {
  assert.equal(uuidSchema.safeParse('123').success, false);
  assert.equal(
    siteRecordSchema.safeParse({
      id: SITE,
      tenantId: TENANT,
      orgNodeId: ORG,
      code: 'OB-001',
      name: 'Obra Demo',
      clientName: 'Cliente Demo',
      budgetTotal: 'cien mil',
      startedAt: null,
      endedAt: null,
      status: 'active',
    }).success,
    false,
  );
});

// ============ W2: request bodies, list envelopes and live validation ============

test('patient create body accepts the documented shape and rejects a bad catalog', () => {
  const valid = {
    orgNodeId: ORG,
    personName: 'Paciente Demo Tres',
    documentType: 'dni',
    documentNumber: '00000003',
    birthdate: '1985-03-04',
    allergies: ['penicilina'],
    alerts: [],
    contacts: { phone: '+51000000003' },
  };
  assert.equal(patientCreateInputSchema.safeParse(valid).success, true);
  assert.equal(
    patientCreateInputSchema.safeParse({ ...valid, documentType: 'ruc' }).success,
    false,
  );
  assert.equal(
    patientCreateInputSchema.safeParse({ ...valid, birthdate: '04/03/1985' }).success,
    false,
  );
  assert.equal(documentTypeSchema.safeParse('ce').success, true);
});

test('appointment create body requires an offset-aware instant and a positive duration', () => {
  const valid = {
    orgNodeId: ORG,
    patientId: PATIENT,
    professionalId: '66666666-6666-4666-8666-666666666666',
    startsAt: '2026-09-25T15:30:00.000Z',
    durationMin: 20,
  };
  assert.equal(appointmentCreateInputSchema.safeParse(valid).success, true);
  assert.equal(
    appointmentCreateInputSchema.safeParse({ ...valid, startsAt: '2026-09-25 15:30' }).success,
    false,
  );
  assert.equal(appointmentCreateInputSchema.safeParse({ ...valid, durationMin: 0 }).success, false);
  assert.equal(appointmentCreateInputSchema.safeParse({ ...valid, durationMin: 12.5 }).success, false);
});

test('consent create body carries the SI/NO matrix and the version coordinates', () => {
  const valid = {
    patientId: PATIENT,
    episodeId: '77777777-7777-4777-8777-777777777777',
    consultingCenter: ORG,
    consultorCenter: '88888888-8888-4888-8888-888888888888',
    informedBy: 'Dra. Demo',
    patientName: 'PACIENTE DEMO UNO',
    docType: 'dni',
    docNumber: '00000001',
    actConsent: 'SI',
    recording: { video: 'SI', audio: 'NO' },
  };
  assert.equal(consentCreateInputSchema.safeParse(valid).success, true);
  assert.equal(
    consentCreateInputSchema.safeParse({ ...valid, actConsent: 'quizá' }).success,
    false,
  );
  assert.equal(consentCreateInputSchema.safeParse({ ...valid, recording: {} }).success, false);
  assert.equal(
    consentCreateInputSchema.safeParse({ ...valid, recording: { video: 'YES' } }).success,
    false,
  );
});

test('list envelopes accept the arrays the API returns for salud', () => {
  assert.equal(patientListSchema.safeParse([]).success, true);
  assert.equal(episodeListSchema.safeParse([]).success, true);
  assert.equal(appointmentListSchema.safeParse([]).success, true);
  assert.equal(consentListSchema.safeParse([]).success, true);
  assert.equal(patientListSchema.safeParse({ rows: [] }).success, false);
});

test('state catalogs reject an unknown status', () => {
  assert.equal(appointmentStatusSchema.safeParse('checked_in').success, true);
  assert.equal(appointmentStatusSchema.safeParse('cancelled').success, false);
});

test('recording catalog mirrors the four §2.6 types and the inclusive scope', () => {
  assert.deepEqual([...CONSENT_RECORD_TYPES], ['imagenes_ayuda', 'fotografias', 'video', 'audio']);
  assert.equal(RECORDING_SCOPE_ALL, 'todo');
  // `todo` is a valid key of the matrix and `video` is the first type the API
  // lists after the inclusive scope; both have to survive the schema.
  assert.equal(
    consentCreateInputSchema.safeParse({
      patientId: PATIENT,
      episodeId: '77777777-7777-4777-8777-777777777777',
      consultingCenter: ORG,
      consultorCenter: '88888888-8888-4888-8888-888888888888',
      informedBy: 'Dra. Demo',
      patientName: 'PACIENTE DEMO UNO',
      docType: 'dni',
      docNumber: '00000001',
      actConsent: 'NO',
      recording: { todo: 'SI' },
    }).success,
    true,
  );
});

test('episode create body accepts an omitted professional and a specialty cap', () => {
  assert.equal(
    episodeCreateInputSchema.safeParse({ patientId: PATIENT, specialty: 'Medicina general' }).success,
    true,
  );
  assert.equal(episodeCreateInputSchema.safeParse({ patientId: 'nope', specialty: 'x' }).success, false);
});

test('live validation: calendar dates are checked against the real month', () => {
  assert.equal(isRealUtcDate('2026-02-30'), false);
  assert.equal(isRealUtcDate('2024-02-29'), true);
  assert.equal(checkDateField('birthdate', ''), null);
  assert.deepEqual(checkDateField('birthdate', '2026-02-30'), {
    field: 'birthdate',
    code: 'invalid_date',
  });
  assert.equal(checkDateField('birthdate', '1990-01-31'), null);
});

test('live validation: DNI is eight digits, other documents are free text', () => {
  assert.deepEqual(checkDocumentNumberField('documentNumber', 'dni', '1234567'), {
    field: 'documentNumber',
    code: 'dni_digits',
  });
  assert.equal(checkDocumentNumberField('documentNumber', 'dni', '12345678'), null);
  assert.equal(checkDocumentNumberField('documentNumber', 'ce', 'X1234567'), null);
  assert.deepEqual(checkDocumentNumberField('documentNumber', 'ce', '  '), {
    field: 'documentNumber',
    code: 'required',
  });
  assert.equal(checkDocumentTypeField('documentType', 'pasaporte'), null);
  assert.equal(checkDocumentTypeField('documentType', 'ruc')?.code, 'invalid_document_type');
});

test('live validation: duration, datetime and evidence fingerprint', () => {
  assert.equal(checkDurationField('durationMin', '20'), null);
  assert.equal(checkDurationField('durationMin', '0')?.code, 'not_positive_integer');
  assert.equal(checkDurationField('durationMin', '20.5')?.code, 'not_positive_integer');
  assert.equal(checkDurationField('durationMin', '600')?.code, 'not_positive_integer');
  assert.equal(checkDateTimeField('startsAt', '2026-09-25T15:30'), null);
  assert.equal(checkDateTimeField('startsAt', '2026-02-30T15:30')?.code, 'invalid_datetime');
  assert.equal(checkDateTimeField('startsAt', '')?.code, 'required');
  assert.equal(checkSha256Field('evidenceSha256', 'a'.repeat(64)), null);
  assert.equal(checkSha256Field('evidenceSha256', 'a'.repeat(63))?.code, 'invalid_sha256');
  assert.equal(checkUuidField('patientId', 'nope')?.code, 'invalid_uuid');
  assert.equal(checkRequiredText('personName', '  ', 120)?.code, 'required');
  assert.equal(checkRequiredText('personName', 'x'.repeat(121), 120)?.code, 'too_long');
});

test('draft aggregation reports the first blocking field', () => {
  const clean = {
    personName: checkRequiredText('personName', 'Paciente Demo', 120),
    documentNumber: checkDocumentNumberField('documentNumber', 'dni', '00000001'),
  };
  assert.equal(draftIsClean(clean), true);
  assert.equal(firstIssue(clean), null);

  const dirty = {
    personName: checkRequiredText('personName', 'Paciente Demo', 120),
    documentNumber: checkDocumentNumberField('documentNumber', 'dni', '1'),
  };
  assert.equal(draftIsClean(dirty), false);
  assert.deepEqual(firstIssue(dirty), { field: 'documentNumber', code: 'dni_digits' });
});

// ============ W3: billing writes, CSV imports and board reads ============

const INVOICE = '99999999-9999-4999-8999-999999999999';

/** One invoice row exactly as `mapInvoice` emits it (synthetic data only). */
function invoiceRow(overrides: Record<string, unknown> = {}): InvoiceRecord {
  return invoiceRecordSchema.parse({
    id: INVOICE,
    tenantId: TENANT,
    orgNodeId: ORG,
    quoteId: null,
    serie: 'F001',
    numero: 1,
    customerDocType: 'dni',
    customerDocNumber: '00000001',
    customerName: 'Paciente Demo Uno',
    items: [{ description: 'Consulta', quantity: 1, unitPrice: 50 }],
    subtotal: 50,
    igvRate: 0.18,
    igvTotal: 9,
    total: 59,
    status: 'issued',
    fiscalStatus: 'pending',
    fiscalAdapter: 'manual_v1',
    fiscalPayload: {},
    cashSessionId: null,
    issuedAt: '2026-09-25T16:05:00.000Z',
    createdAt: '2026-09-25T16:05:00.000Z',
    ...overrides,
  });
}

/** One payment row exactly as `mapPayment` emits it. */
function paymentRow(overrides: Record<string, unknown> = {}): PaymentRecord {
  return paymentRecordSchema.parse({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    tenantId: TENANT,
    invoiceId: INVOICE,
    method: 'efectivo',
    amount: 20,
    status: 'registered',
    externalRef: null,
    paidAt: '2026-09-25T16:10:00.000Z',
    ...overrides,
  });
}

test('billing line refuses a non-positive quantity and a negative unit price', () => {
  assert.equal(billingLineSchema.safeParse({ description: 'Consulta', quantity: 1, unitPrice: 50 }).success, true);
  assert.equal(billingLineSchema.safeParse({ description: 'Consulta', quantity: 0, unitPrice: 50 }).success, false);
  assert.equal(billingLineSchema.safeParse({ description: 'Consulta', quantity: 1, unitPrice: -1 }).success, false);
  assert.equal(billingLineSchema.safeParse({ description: '  ', quantity: 1, unitPrice: 50 }).success, false);
});

test('cash session bodies mirror parseCashSessionOpen and parseCashSessionClose', () => {
  assert.equal(cashSessionOpenInputSchema.safeParse({ orgNodeId: ORG }).success, true);
  assert.equal(cashSessionOpenInputSchema.safeParse({ orgNodeId: 'no-es-uuid' }).success, false);
  assert.equal(cashSessionOpenInputSchema.safeParse({}).success, false);
  assert.equal(cashSessionCloseInputSchema.safeParse({ cashSessionId: ORG, totals: { efectivo: 118 } }).success, true);
  assert.equal(cashSessionCloseInputSchema.safeParse({ cashSessionId: ORG, totals: [] }).success, false);
});

test('quote create body needs a customer, one line and a non-negative total', () => {
  const line = { description: 'Consulta', quantity: 1, unitPrice: 50 };
  const ok = quoteCreateInputSchema.safeParse({ orgNodeId: ORG, customerName: 'Paciente Demo', items: [line] });
  assert.equal(ok.success, true);
  assert.equal(
    quoteCreateInputSchema.safeParse({ orgNodeId: ORG, customerName: '   ', items: [line] }).success,
    false,
  );
  assert.equal(
    quoteCreateInputSchema.safeParse({ orgNodeId: ORG, customerName: 'Paciente Demo', items: [] }).success,
    false,
  );
  assert.equal(
    quoteCreateInputSchema.safeParse({ orgNodeId: ORG, customerName: 'Paciente Demo', items: [line], total: -1 })
      .success,
    false,
  );
});

test('quote list accepts the API array shape', () => {
  const parsed = quoteListSchema.parse([
    {
      id: '77777777-7777-4777-8777-777777777777',
      tenantId: TENANT,
      orgNodeId: ORG,
      customerName: 'Paciente Demo Uno',
      items: [{ description: 'Consulta', quantity: 1, unitPrice: 50 }],
      total: 50,
      status: 'draft',
      createdAt: '2026-09-25T15:00:00.000Z',
    },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.status, 'draft');
});

test('invoice issue body enforces the document rule of its own type', () => {
  const base = {
    orgNodeId: ORG,
    serie: 'F001',
    customerDocType: 'dni',
    customerDocNumber: '00000001',
    customerName: 'Paciente Demo Uno',
    items: [{ description: 'Consulta', quantity: 1, unitPrice: 50 }],
  };
  assert.equal(invoiceIssueInputSchema.safeParse(base).success, true);
  // A dni is eight digits: one short is the exact 400 the service raises.
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, customerDocNumber: '0000001' }).success, false);
  const ruc = { ...base, customerDocType: 'ruc', customerDocNumber: '20123456789' };
  assert.equal(invoiceIssueInputSchema.safeParse(ruc).success, true);
  assert.equal(invoiceIssueInputSchema.safeParse({ ...ruc, customerDocNumber: '2012345678' }).success, false);
  // ce and pasaporte stay free text, like `parseInvoiceIssue` allows.
  assert.equal(
    invoiceIssueInputSchema.safeParse({ ...base, customerDocType: 'ce', customerDocNumber: 'X1234567' }).success,
    true,
  );
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, customerDocType: 'vat' }).success, false);
  // The service uppercases the serie, so the form sends it already uppercase.
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, serie: 'f001' }).success, false);
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, serie: 'F0012345678' }).success, false);
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, igvRate: 1.5 }).success, false);
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, igvRate: 0.18 }).success, true);
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, items: [] }).success, false);
  assert.equal(invoiceIssueInputSchema.safeParse({ ...base, cashSessionId: 'no-es-uuid' }).success, false);
});

test('pay and void bodies mirror the inline service checks', () => {
  assert.equal(invoicePayInputSchema.safeParse({ method: 'efectivo', amount: 59 }).success, true);
  assert.equal(invoicePayInputSchema.safeParse({ method: 'efectivo', amount: 59, externalRef: null }).success, true);
  assert.equal(invoicePayInputSchema.safeParse({ method: 'efectivo', amount: 0 }).success, false);
  assert.equal(invoicePayInputSchema.safeParse({ method: '   ', amount: 59 }).success, false);
  assert.equal(invoiceVoidInputSchema.safeParse({ motivo: 'Error de digitación' }).success, true);
  assert.equal(invoiceVoidInputSchema.safeParse({ motivo: '   ' }).success, false);
  assert.equal(invoiceVoidInputSchema.safeParse({}).success, false);
});

test('status catalogs match the CHECK constraints of migration 004', () => {
  assert.deepEqual(
    [...INVOICE_STATUSES],
    ['draft', 'issued', 'partially_paid', 'paid', 'voided'],
  );
  assert.deepEqual(
    [...FISCAL_STATUSES],
    ['pending', 'sent', 'accepted', 'rejected', 'contingency'],
  );
});

test('pending saldo counts only registered payments, rounded like the API', () => {
  const invoice = invoiceRow({ total: 59 });
  assert.equal(registeredPaidTotal([]), 0);
  assert.equal(registeredPaidTotal([paymentRow({ amount: 20 })]), 20);
  assert.equal(
    registeredPaidTotal([
      paymentRow({ amount: 20 }),
      paymentRow({ id: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', amount: 0.1 }),
    ]),
    round2(20 + 0.1),
  );
  // Reversed and reconciled payments are not part of the saldo.
  assert.equal(registeredPaidTotal([paymentRow({ amount: 20, status: 'reversed' })]), 0);
  assert.equal(registeredPaidTotal([paymentRow({ amount: 20, status: 'reconciled' })]), 0);

  assert.equal(pendingInvoiceTotal(invoice, []), 59);
  assert.equal(pendingInvoiceTotal(invoice, [paymentRow({ amount: 20 })]), 39);
  assert.equal(pendingInvoiceTotal(invoice, [paymentRow({ amount: 59 })]), 0);
  // A data drift never produces a negative saldo in the UI.
  assert.equal(pendingInvoiceTotal(invoice, [paymentRow({ amount: 80 })]), 0);
});

test('invoice issue input is accepted field-for-field as the service reads it', () => {
  const parsed = invoiceIssueInputSchema.parse({
    orgNodeId: ORG,
    quoteId: '77777777-7777-4777-8777-777777777777',
    serie: 'F001',
    customerDocType: 'ruc',
    customerDocNumber: '20123456789',
    customerName: 'Empresa Demo SAC',
    igvRate: 0.18,
    cashSessionId: ORG,
    items: [{ description: 'Consulta', quantity: 2, unitPrice: 25.5 }],
  });
  assert.equal(parsed.serie, 'F001');
  assert.equal(parsed.items.length, 1);
});

test('patients import body needs the CSV text and the sede', () => {
  const ok = patientsImportInputSchema.safeParse({ csv: 'person_name\nPaciente Demo', orgNodeId: ORG });
  assert.equal(ok.success, true);
  assert.equal(patientsImportInputSchema.safeParse({ csv: '   ', orgNodeId: ORG }).success, false);
  assert.equal(patientsImportInputSchema.safeParse({ csv: 'x', orgNodeId: 'nope' }).success, false);
  assert.deepEqual([...PATIENTS_CSV_REQUIRED_COLUMNS], ['person_name', 'document_type', 'document_number']);
});

test('import job record accepts a clean run and a run with errors', () => {
  const clean = importJobRecordSchema.parse({
    id: '55555555-5555-4555-8555-555555555555',
    tenantId: TENANT,
    kind: 'patient_files_csv',
    status: 'completed',
    rowsOk: 3,
    rowsError: 0,
    fileId: '66666666-6666-4666-8666-666666666666',
    fileSha256: 'a'.repeat(64),
    errorsFileId: null,
    errorsCsv: null,
    createdAt: '2026-09-25T17:00:00.000Z',
  });
  assert.equal(importJobIsClean(clean), true);

  const partial = importJobRecordSchema.parse({
    ...clean,
    rowsOk: 2,
    rowsError: 1,
    errorsFileId: '88888888-8888-4888-8888-888888888888',
    errorsCsv: 'row,field,code,message\n2,document_number,import.field_required,DNI requerido',
  });
  assert.equal(importJobIsClean(partial), false);
  assert.match(partial.errorsCsv ?? '', /import\.field_required/);
});

test('salud board query string omits empty fields and keeps org before date', () => {
  assert.equal(saludBoardQueryString(), '');
  assert.equal(saludBoardQueryString({}), '');
  assert.equal(saludBoardQueryString({ org: ORG }), `?org=${ORG}`);
  assert.equal(saludBoardQueryString({ date: '2026-09-25' }), '?date=2026-09-25');
  assert.equal(saludBoardQueryString({ org: ORG, date: '2026-09-25' }), `?org=${ORG}&date=2026-09-25`);
  assert.equal(saludBoardQueryString({ date: '' }), '');
});

test('board poll period is clamped into the 1-5 minute band', () => {
  assert.equal(clampBoardPollMs(1), BOARD_POLL_MIN_MS);
  assert.equal(clampBoardPollMs(600_000), BOARD_POLL_MAX_MS);
  assert.equal(clampBoardPollMs(BOARD_POLL_DEFAULT_MS), BOARD_POLL_DEFAULT_MS);
  assert.equal(clampBoardPollMs(Number.NaN), BOARD_POLL_DEFAULT_MS);
  assert.equal(clampBoardPollMs(150_000), 150_000);
  assert.ok(BOARD_POLL_MIN_MS >= 60_000 && BOARD_POLL_MAX_MS <= 300_000);
});

test('a board is only reachable by the role that owns it', () => {
  assert.equal(boardRoleFor('caja'), 'caja');
  assert.equal(boardRoleFor('recepcion'), 'recepcion');
  assert.equal(boardRoleFor('medico'), 'medico');
  assert.equal(boardRoleFor('enfermeria'), null);
  assert.equal(boardRoleFor('direccion'), null);
  assert.equal(boardRoleFor(null), null);
});

test('billing live validation: serie, document number and money fields', () => {
  assert.equal(checkSerieField('serie', 'f001'), null);
  assert.equal(checkSerieField('serie', 'F001'), null);
  assert.equal(checkSerieField('serie', '')?.code, 'required');
  assert.equal(checkSerieField('serie', 'F0012345678')?.code, 'invalid_serie');
  assert.equal(checkSerieField('serie', 'F-001')?.code, 'invalid_serie');

  assert.equal(checkInvoiceDocumentNumberField('customerDocNumber', 'dni', '12345678'), null);
  assert.equal(checkInvoiceDocumentNumberField('customerDocNumber', 'dni', '1234567')?.code, 'invalid_document_number');
  assert.equal(checkInvoiceDocumentNumberField('customerDocNumber', 'ruc', '20123456789'), null);
  assert.equal(checkInvoiceDocumentNumberField('customerDocNumber', 'ruc', '2012345678')?.code, 'invalid_document_number');
  assert.equal(checkInvoiceDocumentNumberField('customerDocNumber', 'ce', 'X1234567'), null);
  assert.equal(checkInvoiceDocumentNumberField('customerDocNumber', 'dni', '')?.code, 'required');

  assert.equal(checkQuantityField('quantity', '2'), null);
  assert.equal(checkQuantityField('quantity', '0')?.code, 'invalid_amount');
  assert.equal(checkQuantityField('quantity', '1,5')?.code, 'invalid_amount');
  assert.equal(checkQuantityField('quantity', '')?.code, 'required');
  assert.equal(checkUnitPriceField('unitPrice', '0'), null);
  assert.equal(checkUnitPriceField('unitPrice', '25.50'), null);
  assert.equal(checkUnitPriceField('unitPrice', '-1')?.code, 'invalid_amount');

  assert.equal(checkAmountField('amount', '59'), null);
  assert.equal(checkAmountField('amount', '0')?.code, 'invalid_amount');
  assert.equal(checkAmountField('amount', '59.999')?.code, 'invalid_amount');
  assert.equal(checkIgvRateField('igvRate', '0.18'), null);
  assert.equal(checkIgvRateField('igvRate', '1.5')?.code, 'invalid_rate');
  assert.equal(checkIgvRateField('igvRate', '')?.code, 'required');
});

test('payment validation refuses an over-payment against the pending saldo', () => {
  assert.equal(checkAmountWithinPending('amount', '39', 39), null);
  assert.equal(checkAmountWithinPending('amount', '39.01', 39)?.code, 'amount_exceeds_pending');
  assert.equal(checkAmountWithinPending('amount', '0', 39)?.code, 'invalid_amount');
  assert.equal(checkAmountWithinPending('amount', '', 39)?.code, 'required');
});

test('optional amount is an absence, not a zero, on the arqueo fields', () => {
  assert.equal(checkOptionalAmountField('totals.efectivo', ''), null);
  assert.equal(checkOptionalAmountField('totals.efectivo', '118'), null);
  assert.equal(checkOptionalAmountField('totals.efectivo', '118.5'), null);
  assert.equal(checkOptionalAmountField('totals.efectivo', '-1')?.code, 'invalid_amount');
  assert.equal(checkOptionalAmountField('totals.efectivo', '1,5')?.code, 'invalid_amount');
});

// ============ obras request bodies and board read path (W4) ============

test('site create body applies the parser defaults and refuses a bad payload', () => {
  const parsed = siteCreateInputSchema.parse({
    orgNodeId: ORG,
    code: 'OB-001',
    name: 'Obra Demo Uno',
    clientName: 'Cliente Demo',
  });
  // The API fills both when the field is absent, so the mirror does too.
  assert.equal(parsed.budgetTotal, 0);
  assert.equal(parsed.status, 'planned');

  assert.equal(
    siteCreateInputSchema.parse({
      orgNodeId: ORG,
      code: 'OB-002',
      name: 'Obra Demo Dos',
      clientName: 'Cliente Demo',
      budgetTotal: 1500.5,
      status: 'active',
    }).status,
    'active',
  );

  assert.equal(
    siteCreateInputSchema.safeParse({ orgNodeId: 'not-a-uuid', code: 'OB', name: 'n', clientName: 'c' })
      .success,
    false,
  );
  assert.equal(
    siteCreateInputSchema.safeParse({
      orgNodeId: ORG,
      code: 'OB-003',
      name: 'Obra Demo Tres',
      clientName: 'Cliente Demo',
      budgetTotal: -1,
    }).success,
    false,
  );
  assert.equal(
    siteCreateInputSchema.safeParse({
      orgNodeId: ORG,
      code: 'OB-004',
      name: 'Obra Demo Cuatro',
      clientName: 'Cliente Demo',
      status: 'archived',
    }).success,
    false,
  );
  assert.equal(siteStatusSchema.safeParse('closing').success, true);
});

test('assignment body accepts an absent crew and refuses a malformed worker', () => {
  const parsed = assignmentCreateInputSchema.parse({
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    roleInSite: 'capataz',
  });
  assert.equal(parsed.crewId, null);

  const withCrew = assignmentCreateInputSchema.parse({
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    crewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    roleInSite: 'operario',
  });
  assert.equal(withCrew.crewId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

  assert.equal(
    assignmentCreateInputSchema.safeParse({ userId: 'nope', roleInSite: 'capataz' }).success,
    false,
  );
  assert.equal(
    assignmentCreateInputSchema.safeParse({ userId: ORG, crewId: 'nope', roleInSite: 'capataz' })
      .success,
    false,
  );
  assert.equal(assignmentCreateInputSchema.safeParse({ userId: ORG, roleInSite: '' }).success, false);
});

test('attendance mark body defaults the source and keeps the own-user rule visible', () => {
  const own = attendanceMarkInputSchema.parse({ siteId: SITE });
  // The UI never sends `userId`: the service denies a foreign subject.
  assert.equal(own.userId, undefined);
  assert.equal(own.source, 'web');

  const explicit = attendanceMarkInputSchema.parse({
    siteId: SITE,
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    source: 'kiosk',
  });
  assert.equal(explicit.userId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(explicit.source, 'kiosk');

  assert.equal(attendanceMarkInputSchema.safeParse({ siteId: 'nope' }).success, false);
  assert.equal(attendanceMarkInputSchema.safeParse({ siteId: SITE, userId: 'nope' }).success, false);
});

test('attendance record and catalog mirror the API states', () => {
  const parsed = attendanceRecordSchema.parse({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenantId: TENANT,
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    siteId: SITE,
    checkIn: '2026-09-25T08:00:00.000Z',
    checkOut: null,
    source: 'web',
    status: 'registered',
    approvedBy: null,
  });
  assert.equal(parsed.status, 'registered');
  assert.deepEqual([...ATTENDANCE_STATUSES], ['registered', 'approved', 'rejected', 'adjusted']);
  assert.equal(attendanceStatusSchema.safeParse('adjusted').success, true);
  assert.equal(attendanceStatusSchema.safeParse('approved').success, true);
  assert.equal(attendanceStatusSchema.safeParse('pending').success, false);
});

test('site status catalog keeps the API CHECK values in order', () => {
  assert.deepEqual(
    [...SITE_STATUSES],
    ['planned', 'active', 'suspended', 'closing', 'closed', 'cancelled'],
  );
  assert.equal(siteStatusSchema.safeParse('planned').success, true);
  assert.equal(siteStatusSchema.safeParse('suspended').success, true);
  assert.equal(siteStatusSchema.safeParse('closed').success, true);
  assert.equal(siteStatusSchema.safeParse('done').success, false);
});

test('attendance query string keeps site before date and omits empty fields', () => {
  assert.equal(attendanceQueryString(), '');
  assert.equal(attendanceQueryString({ site: SITE }), `?site=${SITE}`);
  assert.equal(attendanceQueryString({ date: '2026-09-25' }), '?date=2026-09-25');
  assert.equal(
    attendanceQueryString({ site: SITE, date: '2026-09-25' }),
    `?site=${SITE}&date=2026-09-25`,
  );
  assert.equal(attendanceQueryString({ site: '', date: '2026-09-25' }), '?date=2026-09-25');
});

test('site board query string omits an absent day and never defaults it', () => {
  assert.equal(siteBoardQueryString(), '');
  assert.equal(siteBoardQueryString({}), '');
  assert.equal(siteBoardQueryString({ date: '2026-09-25' }), '?date=2026-09-25');
  assert.equal(siteBoardQueryString({ date: '' }), '');
});

test('obras board poll period is clamped into the 5-15 minute band', () => {
  assert.equal(clampObrasBoardPollMs(1), OBRAS_BOARD_POLL_MIN_MS);
  assert.equal(clampObrasBoardPollMs(3_600_000), OBRAS_BOARD_POLL_MAX_MS);
  assert.equal(clampObrasBoardPollMs(OBRAS_BOARD_POLL_DEFAULT_MS), OBRAS_BOARD_POLL_DEFAULT_MS);
  assert.equal(clampObrasBoardPollMs(Number.NaN), OBRAS_BOARD_POLL_DEFAULT_MS);
  assert.equal(clampObrasBoardPollMs(450_000), 450_000);
  // Slower than the salud band on purpose: the construction day is not a queue.
  assert.ok(OBRAS_BOARD_POLL_MIN_MS >= 300_000 && OBRAS_BOARD_POLL_MAX_MS <= 900_000);
  assert.ok(OBRAS_BOARD_POLL_MIN_MS >= BOARD_POLL_MAX_MS);
});

test('site board refuses a progress row without the quantities it renders', () => {
  const parsed = siteBoardSchema.parse({
    siteId: SITE,
    siteCode: 'OB-001',
    orgNodeId: ORG,
    date: '2026-09-25',
    progress: [
      {
        budgetLineId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        description: 'Excavación',
        qtyPlanned: 100,
        qtyDone: 40,
        qtyRemaining: 60,
        percent: 40,
      },
    ],
    attendance: { date: '2026-09-25', registered: 2, approved: 1, rejected: 0, adjusted: 0, total: 3 },
    criticalStock: [],
    maintenanceAssets: [],
    upcomingMilestones: [],
  });
  assert.equal(parsed.progress[0]?.qtyRemaining, 60);

  assert.equal(
    siteBoardSchema.safeParse({
      siteId: SITE,
      siteCode: 'OB-001',
      orgNodeId: ORG,
      date: '2026-09-25',
      progress: [{ budgetLineId: ORG, description: 'Excavación', qtyPlanned: 100 }],
      attendance: { date: '2026-09-25', registered: 0, approved: 0, rejected: 0, adjusted: 0, total: 0 },
      criticalStock: [],
      maintenanceAssets: [],
      upcomingMilestones: [],
    }).success,
    false,
  );
});

// ============ W5: obras operation contracts ============

const ASSET = '77777777-7777-4777-8777-777777777777';
const ITEM = '88888888-8888-4888-8888-888888888888';
const WAREHOUSE = '99999999-9999-4999-8999-999999999999';
const BUDGET_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('asset record mirrors the assets row of 005_obras.sql', () => {
  const parsed = assetRecordSchema.parse({
    id: ASSET,
    tenantId: TENANT,
    orgNodeId: ORG,
    code: 'EX-01',
    kind: 'maquinaria',
    serial: 'SN-0001',
    status: 'available',
    currentSiteId: null,
  });
  assert.equal(parsed.status, 'available');
  assert.equal(parsed.currentSiteId, null);
  assert.equal(ASSET_STATUSES.includes(parsed.status as 'available'), true);
  assert.equal(assetRecordSchema.safeParse({ ...parsed, status: 'available' } as const).success, true);
});

test('asset reading keeps the numeric horometer and the insert-only shape', () => {
  const parsed = assetReadingRecordSchema.parse({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: TENANT,
    assetId: ASSET,
    kind: 'horometro',
    value: 128.5,
    at: '2026-09-25T10:00:00.000Z',
    source: 'manual',
  });
  assert.equal(parsed.value, 128.5);
  assert.equal(
    assetReadingRecordSchema.safeParse({ ...parsed, value: '128.5' }).success,
    false,
  );
});

test('stock move exposes the three kinds and the three statuses of the CHECK', () => {
  const parsed = stockMoveRecordSchema.parse({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId: TENANT,
    itemId: ITEM,
    warehouseNodeId: WAREHOUSE,
    siteId: SITE,
    qty: 3,
    kind: 'out',
    at: '2026-09-25T10:00:00.000Z',
    status: 'posted',
  });
  assert.deepEqual([...STOCK_MOVE_KINDS], ['in', 'out', 'transfer']);
  assert.deepEqual([...STOCK_MOVE_STATUSES], ['draft', 'posted', 'reversed']);
  assert.equal(stockMoveKindSchema.safeParse(parsed.kind).success, true);
  assert.equal(stockMoveKindSchema.safeParse('consumo').success, false);
});

test('a consumption subtracts and an entry adds, exactly as the API aggregates', () => {
  assert.equal(stockMoveSignedQty({ kind: 'in', qty: 10 }), 10);
  assert.equal(stockMoveSignedQty({ kind: 'out', qty: 4 }), -4);
  assert.equal(stockMoveSignedQty({ kind: 'transfer', qty: 2 }), -2);
});

test('asset transitions mirror the service states', () => {
  assert.equal(assetCanBeAssigned('available'), true);
  assert.equal(assetCanBeAssigned('assigned'), false);
  assert.equal(assetCanBeAssigned('maintenance'), false);
  assert.equal(assetCanBeAssigned('retired'), false);
  // A unit in maintenance is still readable; a retired one is not.
  assert.equal(assetCanBeRead('maintenance'), true);
  assert.equal(assetCanBeRead('retired'), false);
});

test('progress entry keeps reportedBy from the token, never from the body', () => {
  const parsed = progressEntryRecordSchema.parse({
    id: BUDGET_LINE,
    tenantId: TENANT,
    siteId: SITE,
    budgetLineId: null,
    qtyDone: 12,
    at: null,
    reportedBy: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    status: 'posted',
  });
  assert.equal(parsed.budgetLineId, null);
  assert.equal(progressEntryListSchema.parse([parsed]).length, 1);
  assert.equal(
    progressEntryCreateInputSchema.parse({ siteId: SITE, qtyDone: 2 }).qtyDone,
    2,
  );
  assert.equal(
    progressEntryCreateInputSchema.safeParse({ siteId: SITE, qtyDone: -1 }).success,
    false,
  );
});

test('site log starts as a draft with metadata-only attachments', () => {
  const parsed = siteLogRecordSchema.parse({
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    tenantId: TENANT,
    siteId: SITE,
    authorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    text: 'Se vació la cimentación del eje A.',
    attachmentIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
    at: '2026-09-25T10:00:00.000Z',
    status: 'draft',
  });
  assert.equal(siteLogIsDraft(parsed), true);
  assert.equal(siteLogIsDraft({ status: 'published' }), false);
  assert.deepEqual(siteLogListSchema.parse([parsed]).length, 1);
  // The POST body carries no status: publishing is its own endpoint.
  assert.deepEqual(Object.keys(siteLogCreateInputSchema.parse({ text: 'avance' })), [
    'text',
    'attachmentIds',
  ]);
  assert.equal(siteLogCreateInputSchema.safeParse({ text: '' }).success, false);
});

test('milestone body accepts any parseable instant and rejects a non-date', () => {
  const parsed = milestoneCreateInputSchema.parse({
    siteId: SITE,
    name: 'Vaciar cimentación',
    dueAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(parsed.name, 'Vaciar cimentación');
  assert.equal(
    milestoneCreateInputSchema.safeParse({ siteId: SITE, name: 'x', dueAt: 'no-es-fecha' }).success,
    false,
  );
  assert.equal(milestoneRecordSchema.safeParse({
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    tenantId: TENANT,
    siteId: SITE,
    name: 'Vaciar cimentación',
    dueAt: '2026-09-01T00:00:00.000Z',
    status: 'late',
  }).success, true);
  assert.deepEqual([...MILESTONE_STATUSES], ['pending', 'done', 'late']);
  assert.deepEqual([...SITE_LOG_STATUSES], ['draft', 'published']);
});

test('the obras number checks mirror requireNumber, decimals included', () => {
  // `requireNumber` in the service only asks for a finite number inside the
  // range, and the columns it writes are plain NUMERIC: 128.555 is accepted by
  // the API, so it has to be accepted by the form.
  assert.equal(checkNumberField('value', '128.555'), null);
  assert.equal(checkNumberField('value', '0'), null);
  assert.equal(checkNumberField('value', '')?.code, 'required');
  assert.equal(checkNumberField('value', '-1')?.code, 'invalid_number');
  assert.equal(checkNumberField('value', 'abc')?.code, 'invalid_number');
  assert.equal(checkPositiveNumberField('qty', '0')?.code, 'invalid_number');
  assert.equal(checkPositiveNumberField('qty', '0.5'), null);
  assert.equal(checkPositiveNumberField('qty', '')?.code, 'required');
});

test('operation bodies apply the defaults the service applies', () => {
  const item = itemCreateInputSchema.parse({ sku: 'CEM-01', name: 'Cemento', unit: 'bolsa' });
  assert.equal(item.minStock, 0);
  assert.equal(
    inventoryItemRecordSchema.parse({
      id: ITEM,
      tenantId: TENANT,
      sku: 'CEM-01',
      name: 'Cemento',
      unit: 'bolsa',
      minStock: 4,
      active: true,
    }).active,
    true,
  );

  const move = stockMoveInputSchema.parse({
    itemId: ITEM,
    warehouseNodeId: WAREHOUSE,
    qty: 1,
    kind: 'out',
  });
  assert.equal(move.siteId, null);
  assert.equal(stockMoveInputSchema.safeParse({ itemId: ITEM, warehouseNodeId: WAREHOUSE, qty: 0, kind: 'out' }).success, false);

  const line = budgetLineCreateInputSchema.parse({ siteId: SITE, description: 'Muro' });
  assert.equal(line.itemId, null);
  assert.equal(line.qtyPlanned, 0);
  assert.equal(line.unitCost, 0);

  const reading = assetReadingInputSchema.parse({ kind: 'horometro', value: 4 });
  assert.equal(reading.source, 'manual');
  assert.equal(assetReadingInputSchema.safeParse({ kind: 'horometro', value: -1 }).success, false);
});

test('progress entries query string names the site and never invents one', () => {
  assert.equal(progressEntriesQueryString(), '');
  assert.equal(progressEntriesQueryString({}), '');
  assert.equal(progressEntriesQueryString({ site: '' }), '');
  assert.equal(progressEntriesQueryString({ site: SITE }), `?site=${SITE}`);
});

test('obras import catalogues mirror the importer parsers', () => {
  assert.deepEqual([...WORKERS_CSV_REQUIRED_COLUMNS], ['name', 'email', 'role']);
  assert.deepEqual([...ASSETS_CSV_REQUIRED_COLUMNS], ['code', 'kind', 'serial']);
  assert.equal(WORKERS_CSV_COLUMNS.includes('org_node_id'), true);
  assert.equal(ASSETS_CSV_COLUMNS.includes('horometer'), true);
  assert.deepEqual([...OBRAS_IMPORT_KINDS], ['workers_csv', 'assets_csv']);
  assert.equal(CONSTRUCTION_ROLES.includes('capataz'), true);
});

test('the three import bodies share one shape and one replay-key contract', () => {
  const workers = workersImportInputSchema.parse({ csv: 'name,email,role\nA,a@b.pe,capataz', orgNodeId: ORG });
  const assets = assetsImportInputSchema.parse({ csv: 'code,kind,serial\nEX-1,maquinaria,SN-1', orgNodeId: ORG });
  assert.equal(workers.orgNodeId, ORG);
  assert.equal(assets.csv.startsWith('code'), true);
  assert.equal(workersImportInputSchema.safeParse({ csv: '   ', orgNodeId: ORG }).success, false);
  assert.equal(assetsImportInputSchema.safeParse({ csv: 'code,kind,serial', orgNodeId: 'nope' }).success, false);
  // The job record is shared by the three importers: the errors CSV download of
  // the obras screen needs no second contract.
  assert.equal(
    importJobRecordSchema.parse({
      id: PATIENT,
      tenantId: TENANT,
      kind: 'workers_csv',
      status: 'completed',
      rowsOk: 2,
      rowsError: 1,
      fileId: null,
      fileSha256: 'a'.repeat(64),
      errorsFileId: null,
      errorsCsv: 'row,field,code,message\n3,email,import.invalid_email,email must be a valid address',
      createdAt: '2026-09-25T10:00:00.000Z',
    }).rowsError,
    1,
  );
});
