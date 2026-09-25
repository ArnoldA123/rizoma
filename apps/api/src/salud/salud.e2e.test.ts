// Salud API end-to-end — HTTP against the real local stack
// (bases-consolidadas-v1.md §3.1, §3.3, §3.5, §4.4).
//
// This suite boots the *built* API (the npm script builds first, so `dist` is
// fresh) and drives the versioned `/v1/salud/*` routes over loopback, with the
// local Postgres/PgBouncer the middleware opens a per-request transaction
// against. It is opt-in: `npm run test:e2e` (a live stack is required), while
// `npm test` stays hermetic.
//
// Identity takes the documented LOCAL/TEST header path (`x-tenant-id` +
// `x-user-id`) so the run does not depend on Keycloak. Every fixture is
// synthetic, written with fixed UUIDs and idempotent upserts, so re-running the
// suite neither duplicates state nor needs a destructive cleanup.
//
// What it proves end-to-end: role denial (§3.5 recepcion/caja), module
// activation, membership subtree scope, the state machine on a closed episode,
// one `audit_log` row per write correlated by trace id, the S3 informed
// consent: `pending → signed` opens the teleinterconsultation while `NO` and
// revocation keep it blocked (peru-anexo-v1.md §2.6, §2.8), and the S4 cashier
// flow: open shift, gapless manual folio, 18 % IGV, `Idempotency-Key`
// replay/conflict and partial/total payments (peru-anexo-v1.md §3).
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..', '..');

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://rizoma:rizoma_demo_password@127.0.0.1:5432/rizoma';
const DATABASE_URL_PGBOUNCER =
  process.env.DATABASE_URL_PGBOUNCER ??
  'postgresql://rizoma:rizoma_demo_password@127.0.0.1:6432/rizoma';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://:rizoma_demo_password@127.0.0.1:6379';

/**
 * CI guard against masking: with `REQUIRE_E2E_DB=1` the suite fails instead
 * of skipping when the database is unreachable, so a green CI job always
 * means the suite really ran. Local runs keep the historic skip.
 */
const REQUIRE_DB = process.env.REQUIRE_E2E_DB === '1';

// ============ synthetic fixtures ============

const TENANT_SALUD = 'a1000000-0000-4000-8000-000000000001';
const TENANT_NO_MODULE = 'a1000000-0000-4000-8000-000000000002';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const SEDE_B = 'b1000000-0000-4000-8000-0000000000b1';
const SEDE_NO_MODULE = 'b1000000-0000-4000-8000-0000000000c1';
const U_RECEPCION = 'c1000000-0000-4000-8000-000000000001';
const U_MEDICO = 'c1000000-0000-4000-8000-000000000002';
const U_ENFERMERIA = 'c1000000-0000-4000-8000-000000000003';
const U_CAJA = 'c1000000-0000-4000-8000-000000000004';
const U_NO_MODULE = 'c1000000-0000-4000-8000-000000000005';
const M_RECEPCION = 'd1000000-0000-4000-8000-000000000001';
const M_MEDICO = 'd1000000-0000-4000-8000-000000000002';
const M_ENFERMERIA = 'd1000000-0000-4000-8000-000000000003';
const M_CAJA = 'd1000000-0000-4000-8000-000000000004';
const M_NO_MODULE = 'd1000000-0000-4000-8000-000000000005';
const FIXTURE_PATIENT = 'e1000000-0000-4000-8000-000000000001';
const FIXTURE_DOCUMENT = '99990001';

interface Actor {
  readonly tenantId: string;
  readonly userId: string;
}

const RECEPCION: Actor = { tenantId: TENANT_SALUD, userId: U_RECEPCION };
const MEDICO: Actor = { tenantId: TENANT_SALUD, userId: U_MEDICO };
const ENFERMERIA: Actor = { tenantId: TENANT_SALUD, userId: U_ENFERMERIA };
const CAJA: Actor = { tenantId: TENANT_SALUD, userId: U_CAJA };
const NO_MODULE: Actor = { tenantId: TENANT_NO_MODULE, userId: U_NO_MODULE };

// ============ harness ============

let db: Client;
let server: ChildProcessWithoutNullStreams | undefined;
let baseUrl = '';
let stackReady = false;
const serverLog: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function seed(): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, name, modules, status)
     VALUES ($1, 'salud e2e', '{crm-core,salud}', 'active'),
            ($2, 'salud e2e no module', '{crm-core}', 'active')
     ON CONFLICT (id) DO UPDATE SET modules = EXCLUDED.modules, status = 'active'`,
    [TENANT_SALUD, TENANT_NO_MODULE],
  );
  await db.query(
    `INSERT INTO org_nodes (id, tenant_id, parent_id, kind, name, active) VALUES
       ($1, $2, NULL, 'sede', 'Sede A', TRUE),
       ($3, $4, NULL, 'sede', 'Sede B', TRUE),
       ($5, $6, NULL, 'sede', 'No-module sede', TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [SEDE_A, TENANT_SALUD, SEDE_B, TENANT_SALUD, SEDE_NO_MODULE, TENANT_NO_MODULE],
  );
  await db.query(
    `INSERT INTO users (id, tenant_id, name, email, active, mfa_enrolled) VALUES
       ($1, $6, 'Recepcion Demo', 'recepcion.e2e@example.invalid', TRUE, TRUE),
       ($2, $6, 'Medico Demo', 'medico.e2e@example.invalid', TRUE, TRUE),
       ($3, $6, 'Enfermeria Demo', 'enfermeria.e2e@example.invalid', TRUE, TRUE),
       ($4, $6, 'Caja Demo', 'caja.e2e@example.invalid', TRUE, TRUE),
       ($5, $7, 'No Module Demo', 'nomodule.e2e@example.invalid', TRUE, TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [U_RECEPCION, U_MEDICO, U_ENFERMERIA, U_CAJA, U_NO_MODULE, TENANT_SALUD, TENANT_NO_MODULE],
  );
  await db.query(
    `INSERT INTO memberships (id, user_id, tenant_id, org_node_id, role, scopes, active)
     VALUES ($1, $6, $7, $8, 'recepcion', '{}', TRUE),
            ($2, $9, $7, $8, 'medico', '{}', TRUE),
            ($3, $10, $7, $8, 'enfermeria', '{}', TRUE),
            ($4, $11, $7, $8, 'caja', '{}', TRUE),
            ($5, $12, $13, $14, 'medico', '{}', TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [
      M_RECEPCION, M_MEDICO, M_ENFERMERIA, M_CAJA, M_NO_MODULE,
      U_RECEPCION, TENANT_SALUD, SEDE_A,
      U_MEDICO, U_ENFERMERIA, U_CAJA, U_NO_MODULE, TENANT_NO_MODULE, SEDE_NO_MODULE,
    ],
  );
  await db.query(
    `INSERT INTO patient_files
       (id, tenant_id, org_node_id, person_name, document_type, document_number, alerts, active)
     VALUES ($1, $2, $3, 'Paciente Fixture', 'dni', $4, '{penicilina}', TRUE)
     ON CONFLICT DO NOTHING`,
    [FIXTURE_PATIENT, TENANT_SALUD, SEDE_A, FIXTURE_DOCUMENT],
  );
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server !== undefined && server.exitCode !== null) {
      throw new Error(`API exited early (code ${server.exitCode})\n${serverLog.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`API did not become healthy at ${baseUrl}\n${serverLog.join('')}`);
}

interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly traceId: string;
}

async function call(
  method: string,
  path: string,
  actor: Actor,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  const traceId = randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': actor.tenantId,
      'x-user-id': actor.userId,
      'x-trace-id': traceId,
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, traceId };
}

interface AuditRow {
  readonly action: string;
  readonly entity: string;
  readonly entity_id: string | null;
  readonly actor: string | null;
  readonly reason: string | null;
}

async function auditByTrace(traceId: string): Promise<AuditRow[]> {
  const result = await db.query(
    `SELECT action, entity, entity_id, actor, diff->>'reason' AS reason
     FROM audit_log WHERE tenant_id = $1 AND diff->>'traceId' = $2`,
    [TENANT_SALUD, traceId],
  );
  return result.rows as AuditRow[];
}

/**
 * Polls a read until it yields a value. The tenant middleware commits the
 * request transaction on the response `finish` event, i.e. *after* the client
 * has already read the body, so a write made by the handler can be a few
 * milliseconds behind the HTTP response on a separate connection.
 */
async function waitFor<T>(read: () => Promise<T | null>, attempts = 80): Promise<T | null> {
  let value: T | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await read();
    if (value !== null) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return value;
}

/** `auditByTrace` once the request transaction has been observed as committed. */
async function auditByTraceEventually(traceId: string, minimum = 1): Promise<AuditRow[]> {
  const rows = await waitFor(async () => {
    const found = await auditByTrace(traceId);
    return found.length >= minimum ? found : null;
  });
  return rows ?? [];
}

/** One `consents` row once its write transaction reached `expectedStatus`. */
async function consentRowEventually(
  consentId: string,
  expectedStatus: string,
): Promise<Record<string, unknown> | null> {
  return waitFor(async () => {
    const result = await db.query(
      `SELECT status, signed_at, evidence_attachment_id FROM consents
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_SALUD, consentId],
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return row.status === expectedStatus ? row : null;
  });
}

function uniqueDni(): string {
  return String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
}

/**
 * Fresh invoice serie per run, so the first emission of the run always proves
 * the gapless folio (`numero === 1`) without depending on data from earlier
 * runs of the suite.
 */
function uniqueSerie(): string {
  return `P${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

/** Synthetic immutable evidence digest for the signed consent (§2.8 rule 2). */
const CONSENT_SHA256 = 'a'.repeat(64);

/** Body of one consent creation; the caller overrides the decision marks. */
async function createConsent(
  actor: Actor,
  episodeId: string,
  overrides: Record<string, unknown> = {},
): Promise<HttpResult> {
  return call('POST', '/v1/salud/consents', actor, {
    patientId: FIXTURE_PATIENT,
    episodeId,
    consultingCenter: SEDE_A,
    consultorCenter: SEDE_B,
    informedBy: 'Dra. Demo Informante',
    patientName: 'PACIENTE FIXTURE',
    docType: 'dni',
    docNumber: FIXTURE_DOCUMENT,
    actConsent: 'SI',
    recording: { todo: 'SI' },
    ...overrides,
  });
}

describe('salud API e2e (local stack)', () => {
  before(async () => {
    db = new Client({ connectionString: DATABASE_URL });
    try {
      await db.connect();
    } catch (error) {
      if (REQUIRE_DB) {
        throw new Error(
          'REQUIRE_E2E_DB=1 is set but the database is unreachable — refusing to skip',
          { cause: error },
        );
      }
      return;
    }
    stackReady = true;
    await seed();

    if (!existsSync(resolve(APP_DIR, 'dist', 'main.js'))) {
      throw new Error('dist/main.js is missing — run `npm run test:e2e` so the build runs first');
    }

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['dist/main.js'], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL,
        DATABASE_URL_PGBOUNCER,
        REDIS_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
    server.stderr.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
    await waitForHealth();
  });

  after(async () => {
    if (server !== undefined) {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        await new Promise((resolveExit) => server?.once('exit', resolveExit));
      }
    }
    if (stackReady) await db.end();
  });

  it('recepción is denied opening the clinical history, and the denial is audited', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('GET', '/v1/salud/patients', RECEPCION);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'access.denied');
    assert.equal(result.body.reason, 'role.denied');
    const audit = await auditByTraceEventually(result.traceId);
    assert.equal(audit.length, 1, 'one access.denied row for the trace');
    assert.equal(audit[0]?.action, 'access.denied');
    assert.equal(audit[0]?.entity, 'patient_file');
    assert.equal(audit[0]?.reason, 'role.denied');
  });

  it('recepción registers a patient file and the write is audited', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/salud/patients', RECEPCION, {
      orgNodeId: SEDE_A,
      personName: 'Paciente Nuevo',
      documentType: 'dni',
      documentNumber: uniqueDni(),
      alerts: ['alergia test'],
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const id = result.body.id;
    assert.equal(typeof id, 'string');
    assert.equal(result.body.tenantId, TENANT_SALUD);
    assert.equal(result.body.orgNodeId, SEDE_A);

    const stored = await db.query(
      'SELECT person_name FROM patient_files WHERE tenant_id = $1 AND id = $2',
      [TENANT_SALUD, id],
    );
    assert.equal(stored.rowCount, 1);

    const audit = await auditByTraceEventually(result.traceId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, 'patient.created');
    assert.equal(audit[0]?.entity, 'patient_file');
    assert.equal(audit[0]?.entity_id, id);
    assert.equal(audit[0]?.actor, U_RECEPCION);
  });

  it('caja is denied every clinical write', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/salud/patients', CAJA, {
      orgNodeId: SEDE_A,
      personName: 'No Permitido',
      documentType: 'dni',
      documentNumber: uniqueDni(),
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.reason, 'role.denied');
  });

  it('a tenant without the salud module is denied with module.inactive', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('GET', '/v1/salud/patients', NO_MODULE);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'access.denied');
    assert.equal(result.body.reason, 'module.inactive');
  });

  it('medico reads and edits the patient file; enfermeria may only read', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const list = await call('GET', '/v1/salud/patients', MEDICO);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    assert.ok(
      (list.body as unknown[]).some(
        (item) => (item as Record<string, unknown>).id === FIXTURE_PATIENT,
      ),
      'the fixture patient is visible to medico in scope',
    );

    const denied = await call('PATCH', `/v1/salud/patients/${FIXTURE_PATIENT}`, ENFERMERIA, {
      personName: 'Enfermeria No Escribe',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'role.denied');

    const edit = await call('PATCH', `/v1/salud/patients/${FIXTURE_PATIENT}`, MEDICO, {
      personName: 'Paciente Fixture Editado',
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.personName, 'Paciente Fixture Editado');
    const audit = await auditByTraceEventually(edit.traceId);
    assert.equal(audit[0]?.action, 'patient.updated');
  });

  it('only medico opens and closes an episode; a closed episode is not writable', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const denied = await call('POST', '/v1/salud/episodes', ENFERMERIA, {
      patientId: FIXTURE_PATIENT,
      specialty: 'medicina general',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'role.denied');

    const created = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId: FIXTURE_PATIENT,
      specialty: 'medicina general',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'open');
    const episodeId = created.body.id;
    assert.equal(typeof episodeId, 'string');

    const closed = await call('PATCH', `/v1/salud/episodes/${episodeId}`, MEDICO);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'closed');
    const audit = await auditByTraceEventually(closed.traceId);
    assert.equal(audit[0]?.action, 'episode.closed');

    const reopened = await call('PATCH', `/v1/salud/episodes/${episodeId}`, MEDICO);
    assert.equal(reopened.status, 403);
    assert.equal(reopened.body.reason, 'state.denied');
  });

  it('recepcion schedules an appointment and caja is denied', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const created = await call('POST', '/v1/salud/appointments', RECEPCION, {
      orgNodeId: SEDE_A,
      patientId: FIXTURE_PATIENT,
      professionalId: U_MEDICO,
      startsAt: '2026-10-01T15:00:00.000Z',
      durationMin: 30,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'scheduled');
    const audit = await auditByTraceEventually(created.traceId);
    assert.equal(audit[0]?.action, 'appointment.created');

    const denied = await call('POST', '/v1/salud/appointments', CAJA, {
      orgNodeId: SEDE_A,
      patientId: FIXTURE_PATIENT,
      professionalId: U_MEDICO,
      startsAt: '2026-10-01T16:00:00.000Z',
      durationMin: 30,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'role.denied');
  });

  it('rejects a duplicate patient document with 409', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/salud/patients', RECEPCION, {
      orgNodeId: SEDE_A,
      personName: 'Paciente Duplicado',
      documentType: 'dni',
      documentNumber: FIXTURE_DOCUMENT,
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'duplicate');
  });

  it('rejects a dangling reference with 400', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/salud/appointments', RECEPCION, {
      orgNodeId: SEDE_A,
      patientId: randomUUID(),
      professionalId: U_MEDICO,
      startsAt: '2026-10-03T15:00:00.000Z',
      durationMin: 30,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'validation.failed');
  });

  it('an out-of-subtree sede is denied with scope.outside_subtree', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/salud/appointments', RECEPCION, {
      orgNodeId: SEDE_B,
      patientId: FIXTURE_PATIENT,
      professionalId: U_MEDICO,
      startsAt: '2026-10-02T15:00:00.000Z',
      durationMin: 30,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.reason, 'scope.outside_subtree');
  });

  it('informed consent: pending → signed opens the session, revocation closes it', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const episode = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId: FIXTURE_PATIENT,
      specialty: 'teleinterconsulta',
    });
    assert.equal(episode.status, 201, JSON.stringify(episode.body));
    const episodeId = String(episode.body.id);

    const created = await createConsent(MEDICO, episodeId);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'pending');
    assert.equal(created.body.templateCode, 'consent.pe.teleinterconsulta');
    assert.equal(created.body.canStartSession, false, 'a pending consent cannot start');
    const consentId = String(created.body.id);
    assert.equal((await auditByTraceEventually(created.traceId))[0]?.action, 'consent.created');

    const signed = await call('POST', `/v1/salud/consents/${consentId}/sign`, MEDICO, {
      evidenceSha256: CONSENT_SHA256,
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.status, 'signed');
    assert.equal(signed.body.canStartSession, true, 'signed + SI opens the session');
    assert.deepEqual(signed.body.allowedRecordingTypes, [
      'imagenes_ayuda',
      'fotografias',
      'video',
      'audio',
    ]);
    const signAudit = await auditByTraceEventually(signed.traceId);
    assert.equal(signAudit[0]?.action, 'consent.signed');
    assert.equal(signAudit[0]?.entity, 'consent');

    const stored = await consentRowEventually(consentId, 'signed');
    assert.notEqual(stored, null, 'the signed row is committed');
    assert.equal(stored?.status, 'signed');
    assert.ok(stored?.signed_at instanceof Date, 'signed_at is stamped');
    assert.equal(typeof stored?.evidence_attachment_id, 'string');

    const revoked = await call('POST', `/v1/salud/consents/${consentId}/revoke`, MEDICO);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.status, 'revoked');
    assert.equal(revoked.body.canStartSession, false, 'revocation blocks new sessions');
    assert.equal(
      (await auditByTraceEventually(revoked.traceId))[0]?.action,
      'consent.revoked',
    );

    const afterRevoke = await consentRowEventually(consentId, 'revoked');
    assert.notEqual(afterRevoke, null, 'the revoked row is preserved');
    assert.equal(afterRevoke?.status, 'revoked');
    assert.ok(afterRevoke?.signed_at instanceof Date, 'the signed evidence stays');
    assert.equal(typeof afterRevoke?.evidence_attachment_id, 'string');

    const list = await call('GET', `/v1/salud/consents?patient=${FIXTURE_PATIENT}`, MEDICO);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const listed = (list.body as Record<string, unknown>[]).find((item) => item.id === consentId);
    assert.equal(listed?.status, 'revoked');
    assert.equal(listed?.canStartSession, false);
  });

  it('a NO medical act never opens the session and is audited as a hard block', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const episode = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId: FIXTURE_PATIENT,
      specialty: 'teleinterconsulta',
    });
    const created = await createConsent(MEDICO, String(episode.body.id), {
      actConsent: 'NO',
      recording: { todo: 'NO' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const signed = await call('POST', `/v1/salud/consents/${String(created.body.id)}/sign`, MEDICO, {
      evidenceSha256: CONSENT_SHA256,
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.status, 'signed', 'the refusal is still recorded');
    assert.equal(signed.body.canStartSession, false, 'NO is a hard block (§2.6)');
    assert.deepEqual(signed.body.allowedRecordingTypes, []);
    const actions = (await auditByTraceEventually(signed.traceId, 2))
      .map((row) => row.action)
      .sort();
    assert.deepEqual(actions, ['consent.session_blocked', 'consent.signed']);
  });

  it('rejects a signed consent without the evidence digest', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const episode = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId: FIXTURE_PATIENT,
      specialty: 'teleinterconsulta',
    });
    const created = await createConsent(MEDICO, String(episode.body.id));
    const signed = await call('POST', `/v1/salud/consents/${String(created.body.id)}/sign`, MEDICO, {});
    assert.equal(signed.status, 400);
    assert.equal(signed.body.code, 'consent.evidence_required');
  });

  it('rejects a consent without a medical-act mark with consent.act_required', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const episode = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId: FIXTURE_PATIENT,
      specialty: 'teleinterconsulta',
    });
    const created = await createConsent(MEDICO, String(episode.body.id), { actConsent: undefined });
    assert.equal(created.status, 400);
    assert.equal(created.body.code, 'consent.act_required');
  });

  it('enfermeria reads the consent history but cannot create one', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const episode = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId: FIXTURE_PATIENT,
      specialty: 'teleinterconsulta',
    });
    const denied = await createConsent(ENFERMERIA, String(episode.body.id));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.reason, 'role.denied');

    const list = await call('GET', `/v1/salud/consents?patient=${FIXTURE_PATIENT}`, ENFERMERIA);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
  });

  it('caja reads no clinical history, yet reaches billing', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const denied = await call('GET', '/v1/salud/patients', CAJA);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'access.denied');
    assert.equal(denied.body.reason, 'role.denied', 'caja has no patient.read (§3.3)');
    const audit = await auditByTraceEventually(denied.traceId);
    assert.equal(audit[0]?.action, 'access.denied');
    assert.equal(audit[0]?.entity, 'patient_file');

    // The inverse: the same caja actor is authorized for the billing surface.
    const quotes = await call('GET', '/v1/billing/quotes', CAJA);
    assert.equal(quotes.status, 200, JSON.stringify(quotes.body));
  });

  it('full flow: registro → consentimiento → cita → atención → cobro → factura', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const serie = uniqueSerie();
    const documentNumber = uniqueDni();

    // 1. Registro — recepción opens a brand new patient file.
    const patient = await call('POST', '/v1/salud/patients', RECEPCION, {
      orgNodeId: SEDE_A,
      personName: 'Paciente Flujo Caja',
      documentType: 'dni',
      documentNumber,
    });
    assert.equal(patient.status, 201, JSON.stringify(patient.body));
    const patientId = String(patient.body.id);

    // 2. Consentimiento — medico opens the episode and signs the PE template.
    const episode = await call('POST', '/v1/salud/episodes', MEDICO, {
      patientId,
      specialty: 'teleinterconsulta',
    });
    assert.equal(episode.status, 201, JSON.stringify(episode.body));
    const episodeId = String(episode.body.id);
    const consent = await createConsent(MEDICO, episodeId, { patientId, docNumber: documentNumber });
    assert.equal(consent.status, 201, JSON.stringify(consent.body));
    const signed = await call('POST', `/v1/salud/consents/${String(consent.body.id)}/sign`, MEDICO, {
      evidenceSha256: CONSENT_SHA256,
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.canStartSession, true);

    // 3. Cita — recepción schedules the appointment.
    const appointment = await call('POST', '/v1/salud/appointments', RECEPCION, {
      orgNodeId: SEDE_A,
      patientId,
      professionalId: U_MEDICO,
      startsAt: '2026-11-01T15:00:00.000Z',
      durationMin: 30,
    });
    assert.equal(appointment.status, 201, JSON.stringify(appointment.body));

    // 4. Atención — the consultation closes the episode.
    const closed = await call('PATCH', `/v1/salud/episodes/${episodeId}`, MEDICO);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, 'closed');

    // 5. Cobro — caja opens the shift.
    const session = await call('POST', '/v1/billing/cash-sessions/open', CAJA, { orgNodeId: SEDE_A });
    assert.equal(session.status, 201, JSON.stringify(session.body));
    assert.equal(session.body.status, 'open');
    const sessionId = String(session.body.id);
    assert.equal((await auditByTraceEventually(session.traceId))[0]?.action, 'cash_session.opened');

    // 6. Factura — manual invoice, PEN 100.00 + 18 % IGV, gapless folio.
    const body = {
      orgNodeId: SEDE_A,
      serie,
      customerDocType: 'dni',
      customerDocNumber: documentNumber,
      customerName: 'PACIENTE FLUJO CAJA',
      items: [{ description: 'Consulta ambulatoria', quantity: 1, unitPrice: 100 }],
      cashSessionId: sessionId,
    };
    const idempotencyKey = `e2e-${randomUUID()}`;
    const invoice = await call('POST', '/v1/billing/invoices/issue', CAJA, body, {
      'idempotency-key': idempotencyKey,
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    const invoiceId = String(invoice.body.id);
    assert.equal(invoice.body.serie, serie);
    assert.equal(invoice.body.numero, 1, 'first invoice of the serie, no gap');
    assert.equal(invoice.body.status, 'issued');
    assert.equal(invoice.body.fiscalStatus, 'pending');
    assert.equal(invoice.body.fiscalAdapter, 'manual_v1');
    assert.equal(invoice.body.subtotal, 100);
    assert.equal(invoice.body.igvRate, 0.18);
    assert.equal(invoice.body.igvTotal, 18);
    assert.equal(invoice.body.total, 118);
    assert.equal(invoice.body.cashSessionId, sessionId);
    const issueAudit = (await auditByTraceEventually(invoice.traceId, 2)).map((row) => row.action);
    assert.ok(issueAudit.includes('invoice.drafted'), JSON.stringify(issueAudit));
    assert.ok(issueAudit.includes('invoice.issued'), JSON.stringify(issueAudit));

    // Idempotency: the same key + same body replays; a different body is a 409.
    const replay = await call('POST', '/v1/billing/invoices/issue', CAJA, body, {
      'idempotency-key': idempotencyKey,
    });
    assert.equal(replay.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.id, invoiceId);
    assert.equal(replay.body.numero, 1);
    const conflict = await call('POST', '/v1/billing/invoices/issue', CAJA, { ...body, customerName: 'OTRO NOMBRE' }, {
      'idempotency-key': idempotencyKey,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'billing.idempotency_conflict');

    const storedCount = await waitFor(async () => {
      const result = await db.query(
        `SELECT count(*)::int AS total FROM invoices WHERE tenant_id = $1 AND serie = $2`,
        [TENANT_SALUD, serie],
      );
      const total = Number((result.rows[0] as { total: number }).total);
      return total >= 1 ? total : null;
    });
    assert.equal(storedCount, 1, 'the replay did not write a second invoice');

    // Payment: partial then the remainder, each step audited.
    const partial = await call('POST', `/v1/billing/invoices/${invoiceId}/pay`, CAJA, {
      method: 'efectivo',
      amount: 50,
    });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal(partial.body.status, 'partially_paid');
    assert.equal((await auditByTraceEventually(partial.traceId, 2))[0]?.action !== undefined, true);

    const settled = await call('POST', `/v1/billing/invoices/${invoiceId}/pay`, CAJA, {
      method: 'yape',
      amount: 68,
      externalRef: 'E2E-1',
    });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.status, 'paid');
    const payAudit = (await auditByTraceEventually(settled.traceId, 2)).map((row) => row.action).sort();
    assert.deepEqual(payAudit, ['invoice.paid', 'payment.registered']);

    // Read back: fiscal status/payload plus the registered payments.
    const read = await call('GET', `/v1/billing/invoices/${invoiceId}`, CAJA);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.status, 'paid');
    assert.equal(read.body.fiscalStatus, 'pending');
    assert.equal(read.body.fiscalAdapter, 'manual_v1');
    assert.equal(read.body.total, 118);
    const payments = Array.isArray(read.body.payments) ? read.body.payments : [];
    assert.equal(payments.length, 2, 'two payments are visible');
  });

  it('emitting an invoice without an open shift is blocked', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const session = await call('POST', '/v1/billing/cash-sessions/open', CAJA, { orgNodeId: SEDE_A });
    assert.equal(session.status, 201, JSON.stringify(session.body));
    const sessionId = String(session.body.id);
    const closed = await call('POST', '/v1/billing/cash-sessions/close', CAJA, {
      cashSessionId: sessionId,
      totals: { efectivo: 0 },
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.status, 'closed');
    assert.equal((await auditByTraceEventually(closed.traceId))[0]?.action, 'cash_session.closed');

    const body = {
      orgNodeId: SEDE_A,
      serie: uniqueSerie(),
      customerDocType: 'dni',
      customerDocNumber: '99990001',
      customerName: 'SIN CAJA',
      items: [{ description: 'Consulta', quantity: 1, unitPrice: 1 }],
      cashSessionId: sessionId,
    };
    const blocked = await call('POST', '/v1/billing/invoices/issue', CAJA, body, {
      'idempotency-key': randomUUID(),
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.code, 'billing.cash_session_closed');

    const unknown = await call(
      'POST',
      '/v1/billing/invoices/issue',
      CAJA,
      { ...body, cashSessionId: randomUUID() },
      { 'idempotency-key': randomUUID() },
    );
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.code, 'billing.cash_session_not_found');
  });
});
