// CSV patient importer + role dashboards coverage (bases-consolidadas-v1.md
// §5.1, §5.4, §6.3).
//
// The SQL client is a small stateful in-memory double that implements the exact
// statements `import.service.ts` and `dashboards.service.ts` issue over a set of
// synthetic tables, so the suite exercises the real control flow (guard,
// per-row validation, duplicate handling, hash idempotency, board queries)
// without Postgres. All data is synthetic (`@example.invalid` identities).
//
// Dashboards coverage lives here because `import.test.ts` is the only test file
// inside the S5 allowed edit surface that the `npm test` script loads; the HTTP
// skin of both services stays covered by `salud.e2e.test.ts` (opt-in stack).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IMPORT_CONSENT_TEMPLATE,
  IMPORT_CONSENT_VERSION,
  IMPORT_ERROR,
  IMPORT_KIND_PATIENT_FILES_CSV,
  IMPORT_ROW_ERROR,
  buildErrorsCsv,
  getImportJob,
  importPatients,
  parsePatientsCsv,
} from './import.service.ts';
import { getBoard, type CajaBoard, type MedicoBoard, type RecepcionBoard } from './dashboards.service.ts';
import type { ActorContext, SaludClient } from './salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000b1';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000b1';
const SEDE_B = 'b1000000-0000-4000-8000-0000000000b2';
const OTHER_TENANT_SEDE = 'b1000000-0000-4000-8000-0000000000b3';
const USER_RECEPCION = 'c1000000-0000-4000-8000-0000000000b1';
const USER_CAJA = 'c1000000-0000-4000-8000-0000000000b2';
const USER_MEDICO = 'c1000000-0000-4000-8000-0000000000b3';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000b1';
const TRACE = 'trace-import-1';
const IDEMPOTENCY_KEY = 'idem-import-1';

const CSV_HEADER =
  'person_name,document_type,document_number,birthdate,phone,org_node_id';

/** Well-formed CSV with two valid rows (one carries the optional columns). */
function validCsv(): string {
  return [
    CSV_HEADER,
    'Paciente Demo Uno,dni,99990001,1990-01-15,999888777,',
    `Paciente Demo Dos,ce,99990002,,,${SEDE_B}`,
  ].join('\n');
}

// ============ in-memory query double ============

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface IdempotencyEntry {
  requestHash: string;
  response: unknown;
  valid: boolean;
}

interface FakeState {
  role: string;
  orgNodeId: string;
  subtree: string[];
  modules: string[];
  /** Keyed `${tenant}|${document_number}` to reproduce the `patient_files` UNIQUE. */
  patients: Map<string, Record<string, unknown>>;
  consents: Record<string, unknown>[];
  attachments: Map<string, Record<string, unknown>>;
  jobs: Map<string, Record<string, unknown>>;
  idempotency: Map<string, IdempotencyEntry>;
  audits: Record<string, unknown>[];
  sequence: number;
}

interface FakeDb {
  readonly client: SaludClient;
  readonly state: FakeState;
  readonly queries: RecordedQuery[];
}

function nextId(state: FakeState): string {
  state.sequence += 1;
  return `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
}

function newState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    role: 'recepcion',
    orgNodeId: SEDE_A,
    subtree: [SEDE_A, SEDE_B],
    modules: ['crm-core', 'salud'],
    patients: new Map(),
    consents: [],
    attachments: new Map(),
    jobs: new Map(),
    idempotency: new Map(),
    audits: [],
    sequence: 0,
    ...overrides,
  };
}

function membershipRow(state: FakeState): Record<string, unknown> {
  const userId =
    state.role === 'caja'
      ? USER_CAJA
      : state.role === 'medico'
        ? USER_MEDICO
        : USER_RECEPCION;
  return {
    id: MEMBERSHIP_ID,
    user_id: userId,
    tenant_id: TENANT_ID,
    org_node_id: state.orgNodeId,
    role: state.role,
    scopes: [],
    active: true,
    valid_from: '2020-01-01T00:00:00.000Z',
    valid_to: null,
    user_active: true,
  };
}

/**
 * Stateful double: one branch per statement fragment the services issue. The
 * branch order matters where fragments share a prefix (`FROM apppointments`
 * aggregates, `idempotency_keys` claim vs read).
 */
function createDb(state: FakeState): FakeDb {
  const queries: RecordedQuery[] = [];

  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      await Promise.resolve();
      queries.push({ text, values });
      const v = values;

      // ---- per-row transaction isolation ----
      // Not stateful here (the double never aborts), but the branch records the
      // savepoint protocol the importer relies on against real Postgres.
      if (
        text.startsWith('SAVEPOINT') ||
        text.startsWith('RELEASE SAVEPOINT') ||
        text.startsWith('ROLLBACK TO SAVEPOINT')
      ) {
        return { rows: [] };
      }

      // ---- guard facts ----
      if (text.includes('FROM memberships')) {
        return { rows: state.role === 'none' ? [] : [membershipRow(state)] };
      }
      if (text.includes('WITH RECURSIVE subtree')) {
        return { rows: state.subtree.map((id) => ({ id })) };
      }
      if (text.includes('SELECT modules FROM tenants')) {
        return { rows: [{ modules: state.modules }] };
      }

      // ---- idempotency store ----
      if (text.includes('INSERT INTO idempotency_keys')) {
        const key = String(v[1]);
        if (state.idempotency.has(key)) return { rows: [] };
        state.idempotency.set(key, { requestHash: String(v[2]), response: null, valid: true });
        return { rows: [{ key }] };
      }
      if (text.includes('FROM idempotency_keys') && text.includes('FOR UPDATE')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry === undefined) return { rows: [] };
        return {
          rows: [
            { request_hash: entry.requestHash, response: entry.response, still_valid: entry.valid },
          ],
        };
      }
      if (text.includes('UPDATE idempotency_keys') && text.includes('SET request_hash')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry !== undefined) {
          entry.requestHash = String(v[2]);
          entry.response = null;
          entry.valid = true;
        }
        return { rows: [] };
      }
      if (text.includes('UPDATE idempotency_keys') && text.includes('SET response')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry !== undefined) entry.response = JSON.parse(String(v[2])) as unknown;
        return { rows: [] };
      }
      if (text.includes('DELETE FROM idempotency_keys')) {
        state.idempotency.delete(String(v[1]));
        return { rows: [] };
      }
      if (text.includes('FROM idempotency_keys')) {
        const entry = state.idempotency.get(String(v[1]));
        if (entry === undefined) return { rows: [] };
        return { rows: [{ response: entry.response }] };
      }

      // ---- importer writes ----
      if (text.includes('INSERT INTO patient_files')) {
        const key = `${String(v[0])}|${String(v[4])}`;
        if (state.patients.has(key)) {
          const duplicate = new Error('duplicate key value violates unique constraint');
          (duplicate as { code?: string }).code = '23505';
          throw duplicate;
        }
        const row: Record<string, unknown> = {
          id: nextId(state),
          tenant_id: v[0],
          org_node_id: v[1],
          person_name: v[2],
          document_type: v[3],
          document_number: v[4],
          birthdate: v[5],
          contacts: JSON.parse(String(v[6])) as Record<string, unknown>,
          active: true,
        };
        state.patients.set(key, row);
        return { rows: [{ id: row.id }] };
      }
      if (text.includes('INSERT INTO consents')) {
        const row = {
          id: nextId(state),
          tenant_id: v[0],
          patient_id: v[1],
          template_code: v[2],
          version: v[3],
          signed_at: null,
          evidence_attachment_id: null,
          status: 'pending',
        };
        state.consents.push(row);
        return { rows: [row] };
      }
      if (text.includes('INSERT INTO attachments')) {
        const id = nextId(state);
        const row = {
          id,
          tenant_id: v[0],
          bucket_key: v[1],
          sha256: v[2],
          mime: 'text/csv',
          size_bytes: v[3],
          uploaded_by: v[4],
        };
        state.attachments.set(id, row);
        return { rows: [{ id }] };
      }
      if (text.includes('INSERT INTO import_jobs')) {
        const id = nextId(state);
        const row = {
          id,
          tenant_id: v[0],
          kind: v[1],
          file_id: v[2],
          status: v[3],
          rows_ok: v[4],
          rows_error: v[5],
          errors_file_id: v[6],
          created_at: '2026-01-01T10:00:00.000Z',
        };
        state.jobs.set(id, row);
        return { rows: [row] };
      }
      if (text.includes('FROM import_jobs')) {
        const job = state.jobs.get(String(v[1]));
        if (job === undefined) return { rows: [] };
        const file = state.attachments.get(String(job.file_id));
        return { rows: [{ ...job, file_sha256: file?.sha256 ?? null }] };
      }

      // ---- audit ----
      if (text.includes('INSERT INTO audit_log')) {
        state.audits.push({
          action: v[2],
          entity: v[3],
          entity_id: v[4],
          org_node_id: v[5],
          diff: JSON.parse(String(v[6])) as Record<string, unknown>,
        });
        return { rows: [] };
      }

      // ---- recepcion board ----
      if (text.includes('FROM appointments') && text.includes('today_appointments')) {
        return {
          rows: [
            {
              today_appointments: 3,
              no_shows: 1,
              queue: 2,
              waiting_avg_min: 12.5,
            },
          ],
        };
      }

      // ---- caja board ----
      if (text.includes('FROM payments')) {
        return { rows: [{ today_collected: 250.5 }] };
      }
      if (text.includes('FROM invoices') && text.includes('invoices_issued')) {
        return { rows: [{ invoices_issued: 4 }] };
      }
      if (text.includes('FROM invoices') && text.includes('fiscal_pending')) {
        return { rows: [{ fiscal_pending: 2 }] };
      }
      if (text.includes('FROM cash_sessions')) {
        return {
          rows: [
            {
              id: 'aa000000-0000-4000-8000-0000000000b1',
              org_node_id: SEDE_A,
              opened_at: '2026-01-01T08:00:00.000Z',
              status: 'open',
            },
          ],
        };
      }

      // ---- medico board ----
      if (text.includes('FROM appointments') && text.includes('my_appointments')) {
        return { rows: [{ my_appointments: 5 }] };
      }
      if (text.includes('FROM episodes')) {
        return { rows: [{ open_episodes: 6 }] };
      }
      if (text.includes('FROM consents') && text.includes('pending_consents')) {
        return { rows: [{ pending_consents: 7 }] };
      }

      return { rows: [] };
    },
  };
  return { client, state, queries };
}

function actor(client: SaludClient, overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    client,
    tenantId: TENANT_ID,
    userId: USER_RECEPCION,
    roles: [],
    traceId: TRACE,
    ip: null,
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

function importBody(csvText = validCsv(), orgNodeId = SEDE_A): Record<string, unknown> {
  return { csv: csvText, orgNodeId };
}

// ============ parsePatientsCsv (§5.4) ============

describe('parsePatientsCsv', () => {
  it('parses a valid file into rows, keeping the optional columns', () => {
    const parsed = parsePatientsCsv(validCsv());
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows.length, 2);
    assert.deepEqual(parsed.rows[0], {
      rowNumber: 2,
      personName: 'Paciente Demo Uno',
      documentType: 'dni',
      documentNumber: '99990001',
      birthdate: '1990-01-15',
      phone: '999888777',
      orgNodeId: null,
    });
    assert.equal(parsed.rows[1]?.birthdate, null);
    assert.equal(parsed.rows[1]?.orgNodeId, SEDE_B);
  });

  it('accepts quoted fields with commas and escaped quotes', () => {
    const csv = [
      CSV_HEADER,
      '"Paciente, Demo ""Uno""",dni,99990001,,,',
    ].join('\n');
    const parsed = parsePatientsCsv(csv);
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.rows[0]?.personName, 'Paciente, Demo "Uno"');
  });

  it('accepts CRLF line endings and ignores blank trailing lines', () => {
    const parsed = parsePatientsCsv(`${validCsv()}\r\n\r\n`);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.errors.length, 0);
  });

  it('reports a missing required column as a structural 400', () => {
    assert.throws(
      () => parsePatientsCsv('person_name,document_type\nPaciente Demo,dni\n'),
      isError(IMPORT_ERROR.invalidCsv),
    );
  });

  it('reports an empty file as a structural 400', () => {
    assert.throws(() => parsePatientsCsv('   '), isError(IMPORT_ERROR.invalidCsv));
  });

  it('collects per-row errors and keeps the valid rows of the same file', () => {
    const csv = [
      CSV_HEADER,
      ',dni,99990001,1990-01-15,,',
      'Paciente Sin Documento,dni,,1990-01-15,,',
      'Paciente Fecha Mala,ce,99990003,15/01/1990,,',
      'Paciente Tipo Malo,rut,99990004,,,',
      'Paciente Bueno,pasaporte,99990005,,,',
    ].join('\n');
    const parsed = parsePatientsCsv(csv);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0]?.documentNumber, '99990005');
    assert.deepEqual(
      parsed.errors.map((e) => [e.rowNumber, e.field, e.code]),
      [
        [2, 'person_name', IMPORT_ROW_ERROR.fieldRequired],
        [3, 'document_number', IMPORT_ROW_ERROR.fieldRequired],
        [4, 'birthdate', IMPORT_ROW_ERROR.invalidDate],
        [5, 'document_type', IMPORT_ROW_ERROR.invalidDocumentType],
      ],
    );
  });

  it('rejects a calendar-invalid date even when it matches YYYY-MM-DD', () => {
    const csv = [CSV_HEADER, 'Paciente Demo,dni,99990001,1990-02-30,,'].join('\n');
    const parsed = parsePatientsCsv(csv);
    assert.equal(parsed.rows.length, 0);
    assert.equal(parsed.errors[0]?.code, IMPORT_ROW_ERROR.invalidDate);
  });

  it('rejects a row org_node_id that is not a UUID', () => {
    const csv = [CSV_HEADER, 'Paciente Demo,dni,99990001,,,not-a-uuid'].join('\n');
    const parsed = parsePatientsCsv(csv);
    assert.equal(parsed.errors[0]?.field, 'org_node_id');
    assert.equal(parsed.errors[0]?.code, IMPORT_ROW_ERROR.invalidOrgNode);
  });
});

// ============ buildErrorsCsv ============

describe('buildErrorsCsv', () => {
  it('emits a header plus one escaped line per error', () => {
    const csv = buildErrorsCsv([
      { rowNumber: 2, field: 'person_name', code: 'import.field_required', message: 'a,b' },
    ]);
    assert.equal(csv, 'row,field,code,message\n2,person_name,import.field_required,"a,b"');
  });
});

// ============ importPatients (§5.4 + §5.1) ============

describe('importPatients', () => {
  it('creates the job, inserts the valid patients and counts the errors', async () => {
    const db = createDb(newState());
    const csv = [
      CSV_HEADER,
      'Paciente Uno,dni,99990001,1990-01-15,999888777,',
      'Paciente Dos,ce,99990002,,,',
      ',dni,99990003,,,',
    ].join('\n');
    const job = await importPatients(actor(db.client), importBody(csv), IDEMPOTENCY_KEY);

    assert.equal(job.kind, IMPORT_KIND_PATIENT_FILES_CSV);
    assert.equal(job.status, 'completed');
    assert.equal(job.rowsOk, 2);
    assert.equal(job.rowsError, 1);
    assert.equal(job.fileSha256?.length, 64);
    assert.ok(job.fileId !== null);
    assert.ok(job.errorsFileId !== null);
    assert.ok(job.errorsCsv !== null);
    assert.match(job.errorsCsv ?? '', /import\.field_required/);
    assert.equal(db.state.patients.size, 2);
  });

  it('marks a pending initial consent for every imported patient', async () => {
    const db = createDb(newState());
    await importPatients(actor(db.client), importBody(), IDEMPOTENCY_KEY);
    assert.equal(db.state.consents.length, 2);
    for (const consent of db.state.consents) {
      assert.equal(consent.template_code, IMPORT_CONSENT_TEMPLATE);
      assert.equal(consent.version, IMPORT_CONSENT_VERSION);
      assert.equal(consent.status, 'pending');
      assert.equal(consent.signed_at, null);
    }
  });

  it('stores the phone in the contacts JSONB and never aborts on a bad row', async () => {
    const db = createDb(newState());
    await importPatients(actor(db.client), importBody(), IDEMPOTENCY_KEY);
    const [patient] = [...db.state.patients.values()];
    assert.deepEqual(patient?.contacts, { phone: '999888777' });
  });

  it('counts a document already in patient_files as a row error instead of aborting', async () => {
    const state = newState();
    state.patients.set(`${TENANT_ID}|99990001`, {
      id: 'existing',
      tenant_id: TENANT_ID,
      org_node_id: SEDE_A,
      document_number: '99990001',
    });
    const db = createDb(state);
    const job = await importPatients(actor(db.client), importBody(validCsv()), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 1);
    assert.match(job.errorsCsv ?? '', /import\.document_duplicate/);
  });

  it('counts two rows with the same document inside the file as a row error', async () => {
    const csv = [
      CSV_HEADER,
      'Paciente Uno,dni,99990001,,,',
      'Paciente Uno Bis,dni,99990001,,,',
    ].join('\n');
    const db = createDb(newState());
    const job = await importPatients(actor(db.client), importBody(csv), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 1);
    assert.equal(db.state.patients.size, 1);
  });

  it('rejects an org node outside the caller subtree without writing the row', async () => {
    const csv = [CSV_HEADER, `Paciente Ajeno,dni,99990001,,,${OTHER_TENANT_SEDE}`].join('\n');
    const db = createDb(newState());
    const job = await importPatients(actor(db.client), importBody(csv), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 0);
    assert.equal(job.rowsError, 1);
    assert.match(job.errorsCsv ?? '', /import\.org_node_out_of_scope/);
    assert.equal(db.state.patients.size, 0);
  });

  it('is idempotent by file hash: a replayed file returns the original job', async () => {
    const db = createDb(newState());
    const first = await importPatients(actor(db.client), importBody(), IDEMPOTENCY_KEY);
    const second = await importPatients(actor(db.client), importBody(), 'another-key');
    assert.equal(second.id, first.id);
    assert.equal(second.rowsOk, first.rowsOk);
    assert.equal(second.errorsCsv, first.errorsCsv);
    assert.equal(db.state.jobs.size, 1);
    assert.equal(db.state.patients.size, 2);
  });

  it('rejects the same file for a different sede with import.idempotency_conflict', async () => {
    const db = createDb(newState());
    await importPatients(actor(db.client), importBody(), IDEMPOTENCY_KEY);
    await assert.rejects(
      importPatients(actor(db.client), importBody(validCsv(), SEDE_B), IDEMPOTENCY_KEY),
      isError(IMPORT_ERROR.idempotencyConflict, 409),
    );
  });

  it('requires the Idempotency-Key header', async () => {
    const db = createDb(newState());
    await assert.rejects(
      importPatients(actor(db.client), importBody(), undefined),
      isError(IMPORT_ERROR.idempotencyKeyRequired),
    );
  });

  it('rejects a body without csv or with a non-UUID orgNodeId', async () => {
    const db = createDb(newState());
    await assert.rejects(
      importPatients(actor(db.client), { csv: '   ', orgNodeId: SEDE_A }, IDEMPOTENCY_KEY),
      isError(IMPORT_ERROR.csvRequired),
    );
    await assert.rejects(
      importPatients(actor(db.client), { csv: validCsv(), orgNodeId: 'nope' }, IDEMPOTENCY_KEY),
      isError(IMPORT_ERROR.invalidOrgNode),
    );
  });

  it('denies the import to a role without patient.write and audits the denial', async () => {
    const db = createDb(newState({ role: 'caja' }));
    await assert.rejects(
      importPatients(actor(db.client, { userId: USER_CAJA }), importBody(), IDEMPOTENCY_KEY),
      isError('access.denied', 403),
    );
    assert.equal(db.state.audits.length, 1);
    assert.equal(db.state.audits[0]?.action, 'access.denied');
  });

  it('writes one import.completed audit row with the run counts', async () => {
    const db = createDb(newState());
    const job = await importPatients(actor(db.client), importBody(), IDEMPOTENCY_KEY);
    const completed = db.state.audits.filter((row) => row.action === 'import.completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.entity, 'import_job');
    assert.equal(completed[0]?.entity_id, job.id);
    const diff = completed[0]?.diff as Record<string, unknown>;
    assert.equal(diff.rowsOk, 2);
    assert.equal(diff.rowsError, 0);
  });

  it('isolates every row insert in a savepoint so a duplicate cannot abort the run', async () => {
    const state = newState();
    state.patients.set(`${TENANT_ID}|99990001`, {
      id: 'existing',
      tenant_id: TENANT_ID,
      org_node_id: SEDE_A,
      document_number: '99990001',
    });
    const db = createDb(state);
    const job = await importPatients(actor(db.client), importBody(validCsv()), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 1);
    assert.equal(job.rowsError, 1);
    const savepoints = db.queries.filter((query) => query.text === 'SAVEPOINT import_row');
    const releases = db.queries.filter((query) => query.text === 'RELEASE SAVEPOINT import_row');
    const rollbacks = db.queries.filter((query) => query.text === 'ROLLBACK TO SAVEPOINT import_row');
    assert.equal(savepoints.length, 2);
    assert.equal(releases.length, 1);
    assert.equal(rollbacks.length, 1);
  });

  it('completes a job whose every row is invalid, with rows_ok = 0', async () => {
    const csv = [CSV_HEADER, 'Paciente Malo,rut,,,'].join('\n');
    const db = createDb(newState());
    const job = await importPatients(actor(db.client), importBody(csv), IDEMPOTENCY_KEY);
    assert.equal(job.rowsOk, 0);
    assert.equal(job.rowsError, 2);
    assert.ok(job.errorsCsv !== null);
  });

  it('recovers the errors CSV of a job through getImportJob', async () => {
    const db = createDb(newState());
    const job = await importPatients(actor(db.client), importBody(), IDEMPOTENCY_KEY);
    const fetched = await getImportJob(actor(db.client), job.id);
    assert.equal(fetched.id, job.id);
    assert.equal(fetched.rowsOk, 2);
    assert.equal(fetched.errorsCsv, job.errorsCsv);
    assert.equal(fetched.fileSha256, job.fileSha256);
  });

  it('404s an unknown import job and 400s a malformed id', async () => {
    const db = createDb(newState());
    await assert.rejects(getImportJob(actor(db.client), 'not-a-uuid'), isError('validation.failed'));
    await assert.rejects(
      getImportJob(actor(db.client), 'aa000000-0000-4000-8000-0000000000b9'),
      isError('not_found', 404),
    );
  });
});

// ============ dashboards (§6.3) ============

describe('getBoard', () => {
  it('returns the recepcion KPIs for the sede', async () => {
    const db = createDb(newState({ role: 'recepcion' }));
    const board = (await getBoard(actor(db.client), 'recepcion', SEDE_A, '2026-01-15')) as RecepcionBoard;
    assert.equal(board.role, 'recepcion');
    assert.equal(board.date, '2026-01-15');
    assert.equal(board.orgNodeId, SEDE_A);
    assert.equal(board.todayAppointments, 3);
    assert.equal(board.waitingAvgMin, 12.5);
    assert.equal(board.noShows, 1);
    assert.equal(board.queue, 2);
  });

  it('returns the caja KPIs with amounts and states only', async () => {
    const db = createDb(newState({ role: 'caja' }));
    const board = (await getBoard(actor(db.client, { userId: USER_CAJA }), 'caja', SEDE_A, '2026-01-15')) as CajaBoard;
    assert.equal(board.todayCollected, 250.5);
    assert.equal(board.invoicesIssued, 4);
    assert.equal(board.fiscalPending, 2);
    assert.equal(board.openSession?.id, 'aa000000-0000-4000-8000-0000000000b1');
    // No clinical field may leak into the cashier board.
    assert.deepEqual(Object.keys(board).sort(), [
      'date',
      'fiscalPending',
      'invoicesIssued',
      'openSession',
      'orgNodeId',
      'role',
      'todayCollected',
    ]);
  });

  it('returns the medico KPIs scoped to the professional', async () => {
    const db = createDb(newState({ role: 'medico' }));
    const board = (await getBoard(actor(db.client, { userId: USER_MEDICO }), 'medico', SEDE_A, '2026-01-15')) as MedicoBoard;
    assert.equal(board.myAppointments, 5);
    assert.equal(board.openEpisodes, 6);
    assert.equal(board.pendingConsents, 7);
  });

  it('defaults the sede to the membership org node and the date to today', async () => {
    const db = createDb(newState({ role: 'recepcion' }));
    const board = (await getBoard(actor(db.client), 'recepcion', undefined, undefined)) as RecepcionBoard;
    assert.equal(board.orgNodeId, SEDE_A);
    assert.match(board.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects an unknown board role with 400', async () => {
    const db = createDb(newState());
    await assert.rejects(
      getBoard(actor(db.client), 'gerencia', SEDE_A, '2026-01-15'),
      isError('dashboard.invalid_role'),
    );
  });

  it('rejects a malformed date and a non-UUID sede with 400', async () => {
    const db = createDb(newState());
    await assert.rejects(
      getBoard(actor(db.client), 'recepcion', SEDE_A, '15/01/2026'),
      isError('dashboard.invalid_date'),
    );
    await assert.rejects(
      getBoard(actor(db.client), 'recepcion', 'nope', '2026-01-15'),
      isError('dashboard.invalid_org_node'),
    );
  });

  it('denies the caja board to recepcion and audits the denial', async () => {
    const db = createDb(newState({ role: 'recepcion' }));
    await assert.rejects(
      getBoard(actor(db.client), 'caja', SEDE_A, '2026-01-15'),
      isError('access.denied', 403),
    );
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal(denied.length, 1);
    const diff = denied[0]?.diff as Record<string, unknown>;
    assert.equal(diff.reason, 'role.denied');
    assert.equal(diff.attemptedAction, 'dashboard.read');
  });

  it('denies the recepcion board to a tenant without the salud module', async () => {
    const db = createDb(newState({ role: 'recepcion', modules: ['crm-core'] }));
    await assert.rejects(
      getBoard(actor(db.client), 'recepcion', SEDE_A, '2026-01-15'),
      isError('access.denied', 403),
    );
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal((denied[0]?.diff as Record<string, unknown>).reason, 'module.inactive');
  });

  it('denies a sede outside the membership subtree', async () => {
    const db = createDb(newState({ role: 'recepcion' }));
    await assert.rejects(
      getBoard(actor(db.client), 'recepcion', OTHER_TENANT_SEDE, '2026-01-15'),
      isError('access.denied', 403),
    );
    const denied = db.state.audits.filter((row) => row.action === 'access.denied');
    assert.equal((denied[0]?.diff as Record<string, unknown>).reason, 'scope.outside_subtree');
  });
});
