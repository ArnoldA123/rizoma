// Consent service coverage for the Peru teleinterconsultation template
// (peru-anexo-v1.md §2.3, §2.6, §2.8): the decision matrix, the session gate,
// the versioned payload and the `pending → signed → revoked` lifecycle.
//
// The SQL client is an in-memory double keyed by statement fragment, so the
// suite asserts the persisted `version` payload and the `audit_log` rows
// without a database. All data is synthetic (`@example.invalid` identities).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONSENT_REASON,
  CONSENT_TEMPLATE,
  CONSENT_TEMPLATE_VERSION,
  RECORD_TYPES,
  allowedRecordingTypes,
  buildConsentVersion,
  canStartSession,
  consentVersionKey,
  createPending,
  decodeConsentVersion,
  encodeConsentVersion,
  effectiveRecordingMark,
  listConsents,
  revokeConsent,
  signConsent,
  validateConsentInput,
  type ConsentRecording,
  type ConsentVersionPayload,
} from './consents.service.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c1000000-0000-4000-8000-0000000000a1';
const USER_ENFERMERIA = 'c1000000-0000-4000-8000-0000000000a2';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e1000000-0000-4000-8000-0000000000a1';
const EPISODE_ID = 'f1000000-0000-4000-8000-0000000000a1';
const CENTER_CONSULTING = 'a2000000-0000-4000-8000-0000000000a1';
const CENTER_CONSULTOR = 'a2000000-0000-4000-8000-0000000000b1';
const CONSENT_ID = 'aa000000-0000-4000-8000-0000000000a1';
const ATTACHMENT_ID = 'ab000000-0000-4000-8000-0000000000a1';
const INFORMED_BY = 'Dra. Demo Informante';
const TRACE = 'trace-consent-1';
const SHA256 = 'a'.repeat(64);

const FORM = { patientName: 'PACIENTE DEMO UNO', docType: 'dni', docNumber: '99990001' };

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: role === 'enfermeria' ? USER_ENFERMERIA : USER_MEDICO,
    tenant_id: TENANT_ID,
    org_node_id: SEDE_A,
    role,
    scopes: [],
    active: true,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

// ============ in-memory query double ============

interface Route {
  readonly match: string;
  readonly rows: readonly Record<string, unknown>[];
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: RecordedQuery[];
}

function createDb(...routes: readonly Route[]): FakeDb {
  const queries: RecordedQuery[] = [];
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      const route = routes.find((candidate) => text.includes(candidate.match));
      return { rows: route?.rows ?? [] };
    },
  };
  return { client, queries };
}

/** Every `audit_log` insert, with its action and decoded `diff`. */
function audits(db: FakeDb): { action: string; diff: Record<string, unknown> }[] {
  return db.queries
    .filter((query) => query.text.includes('INSERT INTO audit_log'))
    .map((query) => ({
      action: String(query.values[2]),
      diff: JSON.parse(String(query.values[6])) as Record<string, unknown>,
    }));
}

function actor(client: SaludClient, overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    client,
    tenantId: TENANT_ID,
    userId: USER_MEDICO,
    roles: [],
    traceId: TRACE,
    ip: null,
    ...overrides,
  };
}

/** Base routes every allowed use case needs (guard facts + patient scope). */
function baseRoutes(
  role = 'medico',
  patientRows: readonly Record<string, unknown>[] = [
    { id: PATIENT_ID, tenant_id: TENANT_ID, org_node_id: SEDE_A },
  ],
): Route[] {
  return [
    { match: 'FROM memberships', rows: [membershipRow(role)] },
    { match: 'WITH RECURSIVE subtree', rows: [{ id: SEDE_A }] },
    { match: 'FROM tenants', rows: [{ modules: ['crm-core', 'salud'] }] },
    { match: 'FROM patient_files', rows: patientRows },
  ];
}

// ============ version payload fixtures ============

function payload(overrides: Partial<ConsentVersionPayload> = {}): ConsentVersionPayload {
  return {
    ...buildConsentVersion({
      patientId: PATIENT_ID,
      episodeId: EPISODE_ID,
      consultingCenter: CENTER_CONSULTING,
      consultorCenter: CENTER_CONSULTOR,
      informedBy: INFORMED_BY,
      actConsent: 'SI',
      recording: { todo: 'SI' },
      form: FORM,
    }),
    ...overrides,
  };
}

function consentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONSENT_ID,
    tenant_id: TENANT_ID,
    patient_id: PATIENT_ID,
    template_code: CONSENT_TEMPLATE,
    version: encodeConsentVersion(payload()),
    signed_at: null,
    evidence_attachment_id: null,
    status: 'pending',
    ...overrides,
  };
}

/** Extracts `{status, body}` from a thrown Nest `HttpException`. */
function httpError(error: unknown): { status: number; body: Record<string, unknown> } | null {
  const candidate = error as { getStatus?: () => number; getResponse?: () => unknown };
  if (typeof candidate.getStatus !== 'function' || typeof candidate.getResponse !== 'function') {
    return null;
  }
  const response = candidate.getResponse() as unknown;
  const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
  return { status: candidate.getStatus(), body };
}

function isError(code: string, status = 400): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    const http = httpError(error);
    return http !== null && http.status === status && http.body.code === code;
  };
}

const CREATE_BODY = {
  patientId: PATIENT_ID,
  episodeId: EPISODE_ID,
  consultingCenter: CENTER_CONSULTING,
  consultorCenter: CENTER_CONSULTOR,
  informedBy: INFORMED_BY,
  actConsent: 'SI',
  recording: { imagenes_ayuda: 'SI', fotografias: 'NO', video: 'NO', audio: 'NO' },
  ...FORM,
};

// ============ §2.3 / §2.6 validation ============

describe('validateConsentInput (§2.3/§2.6)', () => {
  it('accepts an informed consent and normalizes the decision matrix', () => {
    const validated = validateConsentInput(
      {
        ...FORM,
        actConsent: 'SI',
        recording: { imagenes_ayuda: 'SI', fotografias: 'NO', video: 'NO', audio: 'NO' },
      },
      TRACE,
    );
    assert.equal(validated.actConsent, 'SI');
    assert.deepEqual(validated.recording, {
      imagenes_ayuda: 'SI',
      fotografias: 'NO',
      video: 'NO',
      audio: 'NO',
    });
    assert.equal(validated.patientName, FORM.patientName);
  });

  it('uppercases the patient-name snapshot (§2.3 "LETRAS MAYÚSCULAS")', () => {
    const validated = validateConsentInput(
      { ...FORM, patientName: 'Paciente Demo Uno', actConsent: 'SI', recording: { todo: 'NO' } },
      TRACE,
    );
    assert.equal(validated.patientName, 'PACIENTE DEMO UNO');
  });

  it('rejects a missing medical-act mark with consent.act_required', () => {
    assert.throws(
      () => validateConsentInput({ ...FORM, recording: { todo: 'SI' } }, TRACE),
      isError(CONSENT_REASON.actRequired),
    );
  });

  it('rejects a medical-act value that is not SI/NO with consent.act_required', () => {
    assert.throws(
      () => validateConsentInput({ ...FORM, actConsent: 'maybe', recording: { todo: 'SI' } }, TRACE),
      isError(CONSENT_REASON.actRequired),
    );
  });

  it('accepts NO on the medical act — a recorded refusal, not a validation error', () => {
    const validated = validateConsentInput(
      { ...FORM, actConsent: 'NO', recording: { todo: 'NO' } },
      TRACE,
    );
    assert.equal(validated.actConsent, 'NO');
  });

  it('rejects a missing recording map with consent.recording_required', () => {
    assert.throws(
      () => validateConsentInput({ ...FORM, actConsent: 'SI' }, TRACE),
      isError(CONSENT_REASON.recordingRequired),
    );
  });

  it('rejects an empty recording map with consent.recording_required', () => {
    assert.throws(
      () => validateConsentInput({ ...FORM, actConsent: 'SI', recording: {} }, TRACE),
      isError(CONSENT_REASON.recordingRequired),
    );
  });

  it('rejects an unknown recording type with consent.invalid_type', () => {
    assert.throws(
      () => validateConsentInput({ ...FORM, actConsent: 'SI', recording: { ecografia: 'SI' } }, TRACE),
      isError(CONSENT_REASON.invalidType),
    );
  });

  it('rejects a recording mark that is not SI/NO with consent.invalid_type', () => {
    assert.throws(
      () => validateConsentInput({ ...FORM, actConsent: 'SI', recording: { video: 'quizas' } }, TRACE),
      isError(CONSENT_REASON.invalidType),
    );
  });

  it('rejects a docType outside the catalog with consent.invalid_type', () => {
    assert.throws(
      () =>
        validateConsentInput(
          { ...FORM, docType: 'ruc', actConsent: 'SI', recording: { todo: 'SI' } },
          TRACE,
        ),
      isError(CONSENT_REASON.invalidType),
    );
  });

  it('rejects a DNI docNumber that is not 8 digits', () => {
    assert.throws(
      () =>
        validateConsentInput(
          { ...FORM, docNumber: '1234', actConsent: 'SI', recording: { todo: 'SI' } },
          TRACE,
        ),
      isError('validation.failed'),
    );
  });
});

// ============ §2.6 decision matrix ============

describe('canStartSession (§2.8 rule 3)', () => {
  it('permits the session only for a signed consent with act SI', () => {
    assert.equal(canStartSession({ status: 'signed', actConsent: 'SI' }), true);
  });

  it('blocks the session for a signed NO act (hard block)', () => {
    assert.equal(canStartSession({ status: 'signed', actConsent: 'NO' }), false);
  });

  it('blocks the session while the consent is pending', () => {
    assert.equal(canStartSession({ status: 'pending', actConsent: 'SI' }), false);
  });

  it('blocks the session after revocation', () => {
    assert.equal(canStartSession({ status: 'revoked', actConsent: 'SI' }), false);
  });

  it('blocks the session once the consent expired', () => {
    assert.equal(canStartSession({ status: 'expired', actConsent: 'SI' }), false);
  });
});

describe('allowedRecordingTypes (§2.6/§2.8 rule 4)', () => {
  it('returns only the types explicitly marked SI', () => {
    const recording: ConsentRecording = {
      imagenes_ayuda: 'SI',
      fotografias: 'NO',
      video: 'SI',
      audio: 'NO',
    };
    assert.deepEqual(allowedRecordingTypes({ recording }), ['imagenes_ayuda', 'video']);
  });

  it('expands an inclusive todo SI to the whole catalog', () => {
    assert.deepEqual(allowedRecordingTypes({ recording: { todo: 'SI' } }), [...RECORD_TYPES]);
  });

  it('returns no type when todo is NO (all-inclusive refusal)', () => {
    assert.deepEqual(allowedRecordingTypes({ recording: { todo: 'NO' } }), []);
  });

  it('lets an explicit NO override an inclusive todo SI', () => {
    const recording: ConsentRecording = { todo: 'SI', video: 'NO' };
    const allowed = allowedRecordingTypes({ recording });
    assert.ok(!allowed.includes('video'), 'video stays prohibited although todo was SI');
    assert.deepEqual(allowed, ['imagenes_ayuda', 'fotografias', 'audio']);
  });

  it('treats an unmarked type as NOT authorized (fail closed)', () => {
    assert.equal(effectiveRecordingMark({ video: 'SI' }, 'audio'), 'NO');
    assert.deepEqual(allowedRecordingTypes({ recording: { video: 'SI' } }), ['video']);
  });

  it('authorizes nothing when the recording map is empty', () => {
    assert.deepEqual(allowedRecordingTypes({ recording: {} }), []);
  });
});

// ============ §2.8.1 versioned payload ============

describe('consent version (§2.8.1)', () => {
  const keyInput = {
    patientId: PATIENT_ID,
    episodeId: EPISODE_ID,
    consultingCenter: CENTER_CONSULTING,
    consultorCenter: CENTER_CONSULTOR,
  };

  it('derives one version key from patient + episode + centre pair', () => {
    const key = consentVersionKey(keyInput);
    assert.ok(key.includes(PATIENT_ID));
    assert.ok(key.includes(EPISODE_ID));
    assert.ok(key.includes(CENTER_CONSULTING));
    assert.ok(key.includes(CENTER_CONSULTOR));
    assert.equal(key, consentVersionKey({ ...keyInput }));
    assert.ok(key.includes(CONSENT_TEMPLATE));
  });

  it('changes the version key when the patient, episode or a centre changes', () => {
    const base = consentVersionKey(keyInput);
    assert.notEqual(base, consentVersionKey({ ...keyInput, episodeId: CENTER_CONSULTOR }));
    assert.notEqual(base, consentVersionKey({ ...keyInput, patientId: EPISODE_ID }));
    assert.notEqual(base, consentVersionKey({ ...keyInput, consultorCenter: SEDE_A }));
  });

  it('round-trips the encoded payload, including the decision matrix', () => {
    const original = payload({ recording: { todo: 'SI', video: 'NO' } });
    const decoded = decodeConsentVersion(encodeConsentVersion(original));
    assert.deepEqual(decoded, original);
    assert.equal(decoded?.version, CONSENT_TEMPLATE_VERSION);
  });

  it('encodes equal decisions to equal strings (deterministic key order)', () => {
    const a = payload({ recording: { imagenes_ayuda: 'SI', video: 'NO' } });
    const b = payload({ recording: { video: 'NO', imagenes_ayuda: 'SI' } });
    assert.equal(encodeConsentVersion(a), encodeConsentVersion(b));
  });

  it('decodes a foreign or truncated version to null (fail closed)', () => {
    assert.equal(decodeConsentVersion('2025.1'), null);
    assert.equal(decodeConsentVersion('{"schema":"other"}'), null);
    assert.equal(decodeConsentVersion('{not json'), null);
    assert.equal(decodeConsentVersion(''), null);
    assert.equal(decodeConsentVersion(null), null);
  });
});

// ============ lifecycle ============

describe('createPending', () => {
  it('stores a pending row with the versioned payload and audits the write', async () => {
    // The double cannot echo bind parameters, so the stored row carries the
    // payload the service is expected to compute from CREATE_BODY.
    const expectedVersion = encodeConsentVersion(
      buildConsentVersion({
        patientId: PATIENT_ID,
        episodeId: EPISODE_ID,
        consultingCenter: CENTER_CONSULTING,
        consultorCenter: CENTER_CONSULTOR,
        informedBy: INFORMED_BY,
        actConsent: 'SI',
        recording: {
          imagenes_ayuda: 'SI',
          fotografias: 'NO',
          video: 'NO',
          audio: 'NO',
        },
        form: FORM,
      }),
    );
    const db = createDb(...baseRoutes(), {
      match: 'INSERT INTO consents',
      rows: [consentRow({ version: expectedVersion })],
    });
    const created = await createPending(actor(db.client), CREATE_BODY);

    assert.equal(created.status, 'pending');
    assert.equal(created.signedAt, null);
    assert.equal(created.templateCode, CONSENT_TEMPLATE);
    assert.equal(created.templateVersion, CONSENT_TEMPLATE_VERSION);
    assert.equal(created.episodeId, EPISODE_ID);
    assert.equal(created.consultingCenter, CENTER_CONSULTING);
    assert.equal(created.consultorCenter, CENTER_CONSULTOR);
    assert.equal(created.informedBy, INFORMED_BY);
    assert.equal(created.canStartSession, false, 'a pending consent never opens a session');
    assert.deepEqual(created.allowedRecordingTypes, ['imagenes_ayuda']);

    const insert = db.queries.find((query) => query.text.includes('INSERT INTO consents'));
    assert.equal(insert?.values[3], expectedVersion, 'the stored payload is deterministic');
    const stored = decodeConsentVersion(insert?.values[3]);
    assert.equal(stored?.actConsent, 'SI');
    assert.equal(stored?.form.patientName, FORM.patientName);

    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'consent.created');
    assert.equal(trail[0]?.diff.actConsent, 'SI');
    assert.equal(trail[0]?.diff.sessionBlocked, true);
  });

  it('rejects an unknown patient with 404 not_found', async () => {
    const db = createDb(...baseRoutes('medico', []));
    await assert.rejects(
      async () => createPending(actor(db.client), CREATE_BODY),
      isError('not_found', 404),
    );
  });

  it('denies a read-only role with role.denied and audits the denial', async () => {
    const db = createDb(...baseRoutes('enfermeria'), { match: 'INSERT INTO consents', rows: [consentRow()] });
    await assert.rejects(
      async () => createPending(actor(db.client, { userId: USER_ENFERMERIA }), CREATE_BODY),
      isError('access.denied', 403),
    );
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'access.denied');
    assert.equal(trail[0]?.diff.reason, 'role.denied');
  });
});

describe('signConsent', () => {
  it('requires the evidence sha256 (§2.8 rule 2)', async () => {
    const db = createDb(...baseRoutes(), { match: 'FROM consents', rows: [consentRow()] });
    await assert.rejects(
      async () => signConsent(actor(db.client), CONSENT_ID, {}),
      isError(CONSENT_REASON.evidenceRequired),
    );
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO attachments')),
      false,
      'no evidence row is written without a valid sha256',
    );
  });

  it('signs the pending row, stores the evidence attachment and audits it', async () => {
    const signed = consentRow({
      status: 'signed',
      signed_at: '2026-10-01T12:00:00.000Z',
      evidence_attachment_id: ATTACHMENT_ID,
    });
    const db = createDb(
      ...baseRoutes(),
      { match: 'FROM consents', rows: [consentRow()] },
      { match: 'INSERT INTO attachments', rows: [{ id: ATTACHMENT_ID }] },
      { match: "SET status = 'signed'", rows: [signed] },
    );
    const result = await signConsent(actor(db.client), CONSENT_ID, { evidenceSha256: SHA256 });

    assert.equal(result.status, 'signed');
    assert.equal(result.signedAt, '2026-10-01T12:00:00.000Z');
    assert.equal(result.evidenceAttachmentId, ATTACHMENT_ID);
    assert.equal(result.canStartSession, true);
    assert.deepEqual(result.allowedRecordingTypes, [...RECORD_TYPES]);

    const attachment = db.queries.find((query) => query.text.includes('INSERT INTO attachments'));
    assert.equal(attachment?.values[2], SHA256);

    const trail = audits(db);
    assert.equal(trail.length, 1, 'a signed SI act writes only the signed event');
    assert.equal(trail[0]?.action, 'consent.signed');
    assert.equal(trail[0]?.diff.evidenceSha256, SHA256);
    assert.equal(trail[0]?.diff.sessionBlocked, false);
  });

  it('signs a NO act but records the hard session block (§2.8 rule 3)', async () => {
    const refusal = payload({ actConsent: 'NO' });
    const db = createDb(
      ...baseRoutes(),
      { match: 'FROM consents', rows: [consentRow({ version: encodeConsentVersion(refusal) })] },
      { match: 'INSERT INTO attachments', rows: [{ id: ATTACHMENT_ID }] },
      {
        match: "SET status = 'signed'",
        rows: [
          consentRow({
            version: encodeConsentVersion(refusal),
            status: 'signed',
            signed_at: '2026-10-01T12:00:00.000Z',
            evidence_attachment_id: ATTACHMENT_ID,
          }),
        ],
      },
    );
    const result = await signConsent(actor(db.client), CONSENT_ID, { evidenceSha256: SHA256 });

    assert.equal(result.status, 'signed');
    assert.equal(result.canStartSession, false);
    const trail = audits(db);
    assert.deepEqual(
      trail.map((entry) => entry.action),
      ['consent.signed', 'consent.session_blocked'],
    );
    assert.equal(trail[1]?.diff.actConsent, 'NO');
  });

  it('refuses a version payload without the centre pair', async () => {
    const broken = payload({ consultingCenter: '' });
    const db = createDb(...baseRoutes(), {
      match: 'FROM consents',
      rows: [consentRow({ version: encodeConsentVersion(broken) })],
    });
    await assert.rejects(
      async () => signConsent(actor(db.client), CONSENT_ID, { evidenceSha256: SHA256 }),
      isError(CONSENT_REASON.centersRequired),
    );
  });

  it('refuses a version payload without informed_by', async () => {
    const broken = payload({ informedBy: '' });
    const db = createDb(...baseRoutes(), {
      match: 'FROM consents',
      rows: [consentRow({ version: encodeConsentVersion(broken) })],
    });
    await assert.rejects(
      async () => signConsent(actor(db.client), CONSENT_ID, { evidenceSha256: SHA256 }),
      isError(CONSENT_REASON.informedByRequired),
    );
  });

  it('refuses a row that is not pending with state.denied', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'FROM consents',
      rows: [consentRow({ status: 'revoked' })],
    });
    await assert.rejects(
      async () => signConsent(actor(db.client), CONSENT_ID, { evidenceSha256: SHA256 }),
      isError('access.denied', 403),
    );
    assert.equal(audits(db)[0]?.diff.reason, 'state.denied');
  });
});

describe('revokeConsent (§2.8 rule 7)', () => {
  it('moves signed to revoked and preserves the row and its evidence', async () => {
    const db = createDb(
      ...baseRoutes(),
      {
        match: 'FROM consents',
        rows: [consentRow({ status: 'signed', signed_at: '2026-10-01T12:00:00.000Z', evidence_attachment_id: ATTACHMENT_ID })],
      },
      {
        match: "SET status = 'revoked'",
        rows: [consentRow({ status: 'revoked', signed_at: '2026-10-01T12:00:00.000Z', evidence_attachment_id: ATTACHMENT_ID })],
      },
    );
    const revoked = await revokeConsent(actor(db.client), CONSENT_ID);

    assert.equal(revoked.status, 'revoked');
    assert.equal(revoked.canStartSession, false, 'revocation blocks new sessions');
    assert.equal(revoked.evidenceAttachmentId, ATTACHMENT_ID, 'the evidence is preserved');
    assert.equal(
      db.queries.some((query) => query.text.includes('DELETE')),
      false,
      'revocation never deletes the row',
    );
    const trail = audits(db);
    assert.equal(trail[0]?.action, 'consent.revoked');
    assert.equal(trail[0]?.diff.from, 'signed');
    assert.equal(trail[0]?.diff.to, 'revoked');
  });

  it('refuses to revoke a pending consent with state.denied', async () => {
    const db = createDb(...baseRoutes(), { match: 'FROM consents', rows: [consentRow()] });
    await assert.rejects(
      async () => revokeConsent(actor(db.client), CONSENT_ID),
      isError('access.denied', 403),
    );
  });
});

describe('listConsents', () => {
  it('derives the session gate and the allowed recording types per row', async () => {
    const recording: ConsentRecording = { imagenes_ayuda: 'SI', video: 'SI', todo: 'NO' };
    const db = createDb(...baseRoutes(), {
      match: 'patient_id = $2',
      rows: [
        consentRow({
          status: 'signed',
          signed_at: '2026-10-01T12:00:00.000Z',
          evidence_attachment_id: ATTACHMENT_ID,
          version: encodeConsentVersion(payload({ recording })),
        }),
      ],
    });
    const rows = await listConsents(actor(db.client), PATIENT_ID);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.canStartSession, true);
    assert.deepEqual(rows[0]?.allowedRecordingTypes, ['imagenes_ayuda', 'video']);
    assert.equal(rows[0]?.versionKey, consentVersionKey({
      patientId: PATIENT_ID,
      episodeId: EPISODE_ID,
      consultingCenter: CENTER_CONSULTING,
      consultorCenter: CENTER_CONSULTOR,
    }));
  });

  it('fails closed on a version payload this module cannot decode', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'patient_id = $2',
      rows: [consentRow({ version: '2025.1', status: 'signed' })],
    });
    const rows = await listConsents(actor(db.client), PATIENT_ID);

    assert.equal(rows[0]?.actConsent, 'NO');
    assert.equal(rows[0]?.canStartSession, false);
    assert.deepEqual(rows[0]?.allowedRecordingTypes, []);
  });

  it('rejects an unknown patient with 404 not_found', async () => {
    const db = createDb(...baseRoutes('medico', []));
    await assert.rejects(
      async () => listConsents(actor(db.client), PATIENT_ID),
      isError('not_found', 404),
    );
  });
});
