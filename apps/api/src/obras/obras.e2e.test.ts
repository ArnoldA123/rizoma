// Obras API end-to-end — HTTP against the real local stack
// (bases-consolidadas-v1.md §2.4, §3.1, §3.4, §3.5, §4.4).
//
// This suite boots the *built* API (the npm script builds first, so `dist` is
// fresh) and drives the versioned `/v1/obras/*` routes over loopback, with the
// local Postgres/PgBouncer the middleware opens a per-request transaction
// against. It is opt-in: `npm run test:e2e-obras` (a live stack is required),
// while `npm test` stays hermetic. It is a separate suite from
// `salud/salud.e2e.test.ts` and seeds its own tenant, so the two do not share
// state.
//
// Identity takes the documented LOCAL/TEST header path (`x-tenant-id` +
// `x-user-id`) so the run does not depend on Keycloak. Every fixture is
// synthetic, written with fixed UUIDs and idempotent upserts, so re-running the
// suite neither duplicates state nor needs a destructive cleanup.
//
// What it proves end-to-end: the *active assignment* is the access key (a
// worker marks only its own attendance and only where assigned), a manager
// reaches its own sites through the subtree, `almacen` never approves, a
// `jefe_obra` cannot approve outside its sites, a capataz approves only its
// crew, one `audit_log` row per write correlated by trace id, and closing the
// assignment cuts access on the next decision.
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

const TENANT_OBRA = 'a2000000-0000-4000-8000-0000000000e1';
const TENANT_NO_MODULE = 'a2000000-0000-4000-8000-0000000000e2';
const EMPRESA = 'b2000000-0000-4000-8000-0000000000e1';
const SEDE_A = 'b2000000-0000-4000-8000-0000000000e2';
const SEDE_B = 'b2000000-0000-4000-8000-0000000000e3';
const NODE_A = 'b2000000-0000-4000-8000-0000000000e4';
const NODE_B = 'b2000000-0000-4000-8000-0000000000e5';
const NODE_NO_MODULE = 'b2000000-0000-4000-8000-0000000000e6';

const SITE_A_FIXED = 'c2000000-0000-4000-8000-0000000000e2';
const SITE_B = 'c2000000-0000-4000-8000-0000000000e1';

const U_GERENTE = 'd2000000-0000-4000-8000-0000000000e1';
const U_JEFE = 'd2000000-0000-4000-8000-0000000000e2';
const U_CAPATAZ = 'd2000000-0000-4000-8000-0000000000e3';
const U_WORKER = 'd2000000-0000-4000-8000-0000000000e4';
const U_WORKER2 = 'd2000000-0000-4000-8000-0000000000e5';
const U_ALMACEN = 'd2000000-0000-4000-8000-0000000000e6';
const U_BAJA = 'd2000000-0000-4000-8000-0000000000e7';
const U_NO_MODULE = 'd2000000-0000-4000-8000-0000000000e8';

const M_GERENTE = 'e2000000-0000-4000-8000-0000000000e1';
const M_JEFE = 'e2000000-0000-4000-8000-0000000000e2';
const M_CAPATAZ = 'e2000000-0000-4000-8000-0000000000e3';
const M_WORKER = 'e2000000-0000-4000-8000-0000000000e4';
const M_WORKER2 = 'e2000000-0000-4000-8000-0000000000e5';
const M_ALMACEN = 'e2000000-0000-4000-8000-0000000000e6';
const M_BAJA = 'e2000000-0000-4000-8000-0000000000e7';
const M_NO_MODULE = 'e2000000-0000-4000-8000-0000000000e8';

const CREW_A = 'f2000000-0000-4000-8000-0000000000e1';
const ASSIGN_WORKER2_A = 'f2000000-0000-4000-8000-0000000000e2';
const ATT_WORKER2_A = 'f2000000-0000-4000-8000-0000000000e4';
const ATT_WORKER_B = 'f2000000-0000-4000-8000-0000000000e5';

const BAJA_EMAIL = 'baja.obras.e2e@example.invalid';

interface Actor {
  readonly tenantId: string;
  readonly userId: string;
}

const GERENTE: Actor = { tenantId: TENANT_OBRA, userId: U_GERENTE };
const JEFE: Actor = { tenantId: TENANT_OBRA, userId: U_JEFE };
const CAPATAZ: Actor = { tenantId: TENANT_OBRA, userId: U_CAPATAZ };
const WORKER: Actor = { tenantId: TENANT_OBRA, userId: U_WORKER };
const WORKER2: Actor = { tenantId: TENANT_OBRA, userId: U_WORKER2 };
const ALMACEN: Actor = { tenantId: TENANT_OBRA, userId: U_ALMACEN };
const BAJA: Actor = { tenantId: TENANT_OBRA, userId: U_BAJA };
const NO_MODULE: Actor = { tenantId: TENANT_NO_MODULE, userId: U_NO_MODULE };

// ============ harness ============

let db: Client;
let server: ChildProcessWithoutNullStreams | undefined;
let baseUrl = '';
let stackReady = false;
const serverLog: string[] = [];

/** Site created by the flow; shared across the sequential `it`s. */
let obraAId = '';
/** O3 resources created by the flow; shared across the sequential `it`s. */
let assetId = '';
let itemId = '';
let budgetLineId = '';
let siteLogId = '';

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

/** Fresh site code per run, so the flow always creates and never collides. */
function uniqueCode(): string {
  return `OBR-E2E-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
}

async function seed(): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, name, modules, status)
     VALUES ($1, 'obras e2e', '{crm-core,obras}', 'active'),
            ($2, 'obras e2e no module', '{crm-core}', 'active')
     ON CONFLICT (id) DO UPDATE SET modules = EXCLUDED.modules, status = 'active'`,
    [TENANT_OBRA, TENANT_NO_MODULE],
  );
  await db.query(
    `INSERT INTO org_nodes (id, tenant_id, parent_id, kind, name, active) VALUES
       ($1, $2, NULL,   'empresa', 'Constructora Demo', TRUE),
       ($3, $4, $1,     'sede',    'Sede Lima', TRUE),
       ($5, $6, $1,     'sede',    'Sede Arequipa', TRUE),
       ($7, $8, $3,     'obra',    'Obra Lima', TRUE),
       ($9, $10, $5,    'obra',    'Obra Arequipa', TRUE),
       ($11, $12, NULL, 'sede',    'No-module sede', TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [
      EMPRESA, TENANT_OBRA,
      SEDE_A, TENANT_OBRA,
      SEDE_B, TENANT_OBRA,
      NODE_A, TENANT_OBRA,
      NODE_B, TENANT_OBRA,
      NODE_NO_MODULE, TENANT_NO_MODULE,
    ],
  );
  await db.query(
    `INSERT INTO users (id, tenant_id, name, email, active, mfa_enrolled) VALUES
       ($1, $9, 'Gerente Demo', 'gerente.obras.e2e@example.invalid', TRUE, TRUE),
       ($2, $9, 'Jefe de Obra Demo', 'jefe.obras.e2e@example.invalid', TRUE, TRUE),
       ($3, $9, 'Capataz Demo', 'capataz.obras.e2e@example.invalid', TRUE, TRUE),
       ($4, $9, 'Trabajador Demo', 'trabajador.obras.e2e@example.invalid', TRUE, TRUE),
       ($5, $9, 'Trabajador Dos Demo', 'trabajador2.obras.e2e@example.invalid', TRUE, TRUE),
       ($6, $9, 'Almacen Demo', 'almacen.obras.e2e@example.invalid', TRUE, TRUE),
       ($7, $9, 'Baja Demo', $11, FALSE, FALSE),
       ($8, $10, 'No Module Demo', 'nomodule.obras.e2e@example.invalid', TRUE, TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [
      U_GERENTE, U_JEFE, U_CAPATAZ, U_WORKER, U_WORKER2, U_ALMACEN, U_BAJA, U_NO_MODULE,
      TENANT_OBRA, TENANT_NO_MODULE, BAJA_EMAIL,
    ],
  );
  await db.query(
    `INSERT INTO memberships (id, user_id, tenant_id, org_node_id, role, scopes, active) VALUES
       ($1,  $9,  $17, $18, 'gerente',    '{}', TRUE),
       ($2,  $10, $17, $19, 'jefe_obra',  '{}', TRUE),
       ($3,  $11, $17, $20, 'capataz',    '{}', TRUE),
       ($4,  $12, $17, $20, 'trabajador', '{}', TRUE),
       ($5,  $13, $17, $20, 'trabajador', '{}', TRUE),
       ($6,  $14, $17, $18, 'almacen',    '{}', TRUE),
       ($7,  $15, $17, $20, 'trabajador', '{}', FALSE),
       ($8,  $16, $21, $22, 'gerente',    '{}', TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [
      M_GERENTE, M_JEFE, M_CAPATAZ, M_WORKER, M_WORKER2, M_ALMACEN, M_BAJA, M_NO_MODULE,
      U_GERENTE, U_JEFE, U_CAPATAZ, U_WORKER, U_WORKER2, U_ALMACEN, U_BAJA, U_NO_MODULE,
      TENANT_OBRA, EMPRESA, SEDE_A, NODE_A, TENANT_NO_MODULE, NODE_NO_MODULE,
    ],
  );
  await db.query(
    `INSERT INTO crews (id, tenant_id, org_node_id, name, lead_membership_id, active)
     VALUES ($1, $2, $3, 'Cuadrilla Lima A', $4, TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [CREW_A, TENANT_OBRA, NODE_A, M_CAPATAZ],
  );
  await db.query(
    `INSERT INTO sites (id, tenant_id, org_node_id, code, name, client_name, budget_total, started_at, status) VALUES
       ($1, $3, $4, 'OBR-E2E-A', 'Obra Lima E2E', 'Cliente Ficticio', 100000, DATE '2025-01-15', 'active'),
       ($2, $3, $5, 'OBR-E2E-B', 'Obra Arequipa E2E', 'Cliente Ficticio', 100000, DATE '2025-02-03', 'active')
     ON CONFLICT DO NOTHING`,
    [SITE_A_FIXED, SITE_B, TENANT_OBRA, NODE_A, NODE_B],
  );
  await db.query(
    `INSERT INTO assignments (id, tenant_id, user_id, site_id, crew_id, role_in_site, active, valid_from, valid_to) VALUES
       ($1, $2, $3, $4, NULL, 'ayudante', TRUE, DATE '2025-01-15', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ASSIGN_WORKER2_A, TENANT_OBRA, U_WORKER2, SITE_A_FIXED],
  );
  await db.query(
    `INSERT INTO attendance (id, tenant_id, user_id, site_id, check_in, source, status)
     VALUES ($1, $2, $3, $4, TIMESTAMPTZ '2025-02-04 08:05:00+00', 'web', 'registered'),
            ($5, $2, $6, $7, TIMESTAMPTZ '2025-02-04 08:06:00+00', 'web', 'registered')
     ON CONFLICT (id) DO NOTHING`,
    [ATT_WORKER2_A, TENANT_OBRA, U_WORKER2, SITE_A_FIXED, ATT_WORKER_B, U_WORKER, SITE_B],
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
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  const traceId = randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': actor.tenantId,
      'x-user-id': actor.userId,
      'x-trace-id': traceId,
      ...(extraHeaders ?? {}),
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
    [TENANT_OBRA, traceId],
  );
  return result.rows as AuditRow[];
}

/**
 * Polls a read until it yields a value. The tenant middleware commits the
 * request transaction on the response `finish` event, i.e. *after* the client
 * has already read the body, so a write made by the handler can be a few
 * milliseconds behind the HTTP response on a separate connection.
 */
async function waitFor<T>(read: () => Promise<T | null>, attempts = 40): Promise<T | null> {
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

/** One `attendance` row once its write transaction reached `expectedStatus`. */
async function attendanceRowEventually(
  attendanceId: string,
  expectedStatus: string,
): Promise<Record<string, unknown> | null> {
  return waitFor(async () => {
    const result = await db.query(
      `SELECT status, approved_by FROM attendance WHERE tenant_id = $1 AND id = $2`,
      [TENANT_OBRA, attendanceId],
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return row.status === expectedStatus ? row : null;
  });
}

describe('obras API e2e (local stack)', () => {
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
      throw new Error('dist/main.js is missing — run `npm run test:e2e-obras` so the build runs first');
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

  it('gerente creates a site and the write is audited', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const code = uniqueCode();
    const created = await call('POST', '/v1/obras/sites', GERENTE, {
      orgNodeId: NODE_A,
      code,
      name: 'Obra Lima E2E',
      clientName: 'Cliente Ficticio',
      budgetTotal: 250000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.code, code);
    assert.equal(created.body.tenantId, TENANT_OBRA);
    assert.equal(created.body.orgNodeId, NODE_A);
    obraAId = String(created.body.id);

    const stored = await waitFor(async () => {
      const result = await db.query('SELECT code FROM sites WHERE tenant_id = $1 AND id = $2', [
        TENANT_OBRA,
        obraAId,
      ]);
      return result.rowCount === 1 ? true : null;
    });
    assert.equal(stored, true, 'the site is committed');

    const audit = await auditByTraceEventually(created.traceId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, 'site.created');
    assert.equal(audit[0]?.entity, 'site');
    assert.equal(audit[0]?.actor, U_GERENTE);
  });

  it('jefe_obra assigns a worker and a second call is idempotent', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const assigned = await call('POST', `/v1/obras/sites/${obraAId}/staff`, JEFE, {
      userId: U_WORKER,
      crewId: CREW_A,
      roleInSite: 'oficial',
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal(assigned.body.userId, U_WORKER);
    assert.equal(assigned.body.active, true);
    const assignmentId = String(assigned.body.id);
    assert.equal((await auditByTraceEventually(assigned.traceId))[0]?.action, 'assignment.created');

    const again = await call('POST', `/v1/obras/sites/${obraAId}/staff`, JEFE, {
      userId: U_WORKER,
      crewId: CREW_A,
      roleInSite: 'oficial',
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(String(again.body.id), assignmentId, 'idempotent by user + site');
    assert.equal((await auditByTrace(again.traceId)).length, 0, 'no second write audit');
  });

  it('the worker marks its own attendance and the write is audited', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const marked = await call('POST', '/v1/obras/attendance', WORKER, { siteId: obraAId });
    assert.equal(marked.status, 201, JSON.stringify(marked.body));
    assert.equal(marked.body.userId, U_WORKER);
    assert.equal(marked.body.siteId, obraAId);
    assert.equal(marked.body.status, 'registered');
    const audit = await auditByTraceEventually(marked.traceId);
    assert.equal(audit[0]?.action, 'attendance.marked');
    assert.equal(audit[0]?.entity, 'attendance');
  });

  it('the capataz approves the mark of its own crew', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const list = await call('GET', `/v1/obras/attendance?site=${obraAId}&date=${today()}`, JEFE);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const mine = (list.body as unknown as Record<string, unknown>[]).find(
      (row) => row.userId === U_WORKER && row.siteId === obraAId,
    );
    assert.notEqual(mine, undefined, 'the mark is visible to the jefe');
    const attendanceId = String(mine?.id);

    const approved = await call('POST', `/v1/obras/attendance/${attendanceId}/approve`, CAPATAZ);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.approvedBy, U_CAPATAZ);
    const audit = await auditByTraceEventually(approved.traceId);
    assert.equal(audit[0]?.action, 'attendance.approved');

    const stored = await attendanceRowEventually(attendanceId, 'approved');
    assert.notEqual(stored, null, 'the approved row is committed');
    assert.equal(stored?.approved_by, U_CAPATAZ);
  });

  it('the site staff list shows the active assignment', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const staff = await call('GET', `/v1/obras/sites/${obraAId}/staff`, JEFE);
    assert.equal(staff.status, 200);
    assert.ok(Array.isArray(staff.body));
    const row = (staff.body as unknown as Record<string, unknown>[]).find(
      (item) => item.userId === U_WORKER,
    );
    assert.notEqual(row, undefined, 'the jefe sees its worker');
    assert.equal(row?.crewId, CREW_A);
  });

  it('denies storing a duplicate site code with obra.duplicate', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const code = uniqueCode();
    const first = await call('POST', '/v1/obras/sites', GERENTE, {
      orgNodeId: NODE_A,
      code,
      name: 'Obra Duplicada',
      clientName: 'Cliente Ficticio',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await call('POST', '/v1/obras/sites', GERENTE, {
      orgNodeId: NODE_A,
      code,
      name: 'Obra Duplicada',
      clientName: 'Cliente Ficticio',
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'obra.duplicate');
  });

  it('denies a jefe_obra creating a site', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/sites', JEFE, {
      orgNodeId: NODE_A,
      code: uniqueCode(),
      name: 'Obra Prohibida',
      clientName: 'Cliente Ficticio',
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.scope_denied');
    assert.equal(result.body.reason, 'role.denied');
  });

  it('denies a worker marking attendance in a site it is not assigned to', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/attendance', WORKER, { siteId: SITE_B });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.access_denied');
  });

  it('denies marking attendance for another user', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/attendance', WORKER, {
      siteId: obraAId,
      userId: U_WORKER2,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.access_denied');
    assert.equal(result.body.reason, 'attendance.not_own');
  });

  it('denies almacen approving attendance', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', `/v1/obras/attendance/${ATT_WORKER2_A}/approve`, ALMACEN);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.approve_denied');
    assert.equal(result.body.reason, 'role.denied');
  });

  it('denies a jefe_obra approving attendance outside its own site', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', `/v1/obras/attendance/${ATT_WORKER_B}/approve`, JEFE);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.approve_denied');
  });

  it('denies a capataz approving a worker outside its crew', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', `/v1/obras/attendance/${ATT_WORKER2_A}/approve`, CAPATAZ);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.approve_denied');
    assert.equal(result.body.reason, 'crew.mismatch');
  });

  it('denies a tenant without the obras module', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('GET', '/v1/obras/sites', NO_MODULE);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.scope_denied');
    assert.equal(result.body.reason, 'module.inactive');
  });

  it('denies a user given a baja', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/attendance', BAJA, { siteId: SITE_B });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.access_denied');
  });

  it('gerente registers an equipment asset', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const created = await call('POST', '/v1/obras/assets', GERENTE, {
      orgNodeId: NODE_A,
      code: `EQ-${uniqueCode()}`,
      kind: 'mezcladora',
      serial: `SN-${randomUUID()}`,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'available');
    assert.equal(created.body.currentSiteId, null);
    assetId = String(created.body.id);
    const audit = await auditByTraceEventually(created.traceId);
    assert.equal(audit[0]?.action, 'asset.created');
    assert.equal(audit[0]?.entity, 'asset');
  });

  it('jefe_obra assigns the equipment to the site', async (t) => {
    if (!stackReady || obraAId === '' || assetId === '') return t.skip('local stack unavailable');
    const assigned = await call('POST', `/v1/obras/assets/${assetId}/assign`, JEFE, {
      siteId: obraAId,
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.status, 'assigned');
    assert.equal(assigned.body.currentSiteId, obraAId);
    const audit = await auditByTraceEventually(assigned.traceId);
    assert.equal(audit[0]?.action, 'asset.assigned');
  });

  it('the assigned worker records an horometer reading (append-only)', async (t) => {
    if (!stackReady || assetId === '') return t.skip('local stack unavailable');
    const reading = await call('POST', `/v1/obras/assets/${assetId}/readings`, WORKER, {
      kind: 'horometro',
      value: 12.5,
    });
    assert.equal(reading.status, 201, JSON.stringify(reading.body));
    assert.equal(reading.body.assetId, assetId);
    assert.equal(reading.body.value, 12.5);
    const audit = await auditByTraceEventually(reading.traceId);
    assert.equal(audit[0]?.action, 'asset_reading.recorded');
    assert.equal(audit[0]?.entity, 'asset_reading');
  });

  it('denies jefe_obra registering equipment', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/assets', JEFE, {
      orgNodeId: NODE_A,
      code: `EQ-${uniqueCode()}`,
      kind: 'mezcladora',
      serial: `SN-${randomUUID()}`,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.scope_denied');
    assert.equal(result.body.reason, 'role.denied');
  });

  it('almacen creates an item and posts an inbound move', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const item = await call('POST', '/v1/obras/stock/items', ALMACEN, {
      sku: `SKU-${uniqueCode()}`,
      name: 'Cemento Portland',
      unit: 'bolsa',
      minStock: 5,
    });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    itemId = String(item.body.id);
    assert.equal((await auditByTraceEventually(item.traceId))[0]?.action, 'inventory_item.created');

    const inbound = await call('POST', '/v1/obras/stock/moves', ALMACEN, {
      itemId,
      warehouseNodeId: NODE_A,
      qty: 10,
      kind: 'in',
    });
    assert.equal(inbound.status, 201, JSON.stringify(inbound.body));
    assert.equal(inbound.body.status, 'posted');
    assert.equal(inbound.body.kind, 'in');
    assert.equal((await auditByTraceEventually(inbound.traceId))[0]?.action, 'stock_move.posted');
  });

  it('almacen posts a consumption and then reverses it without deleting the row', async (t) => {
    if (!stackReady || itemId === '') return t.skip('local stack unavailable');
    const outbound = await call('POST', '/v1/obras/stock/moves', ALMACEN, {
      itemId,
      warehouseNodeId: NODE_A,
      siteId: obraAId,
      qty: 4,
      kind: 'out',
    });
    assert.equal(outbound.status, 201, JSON.stringify(outbound.body));
    assert.equal(outbound.body.status, 'posted');
    assert.equal(outbound.body.siteId, obraAId);
    const moveId = String(outbound.body.id);

    const reversed = await call('POST', `/v1/obras/stock/moves/${moveId}/reverse`, ALMACEN);
    assert.equal(reversed.status, 200, JSON.stringify(reversed.body));
    assert.equal(reversed.body.status, 'reversed');
    const audit = await auditByTraceEventually(reversed.traceId);
    assert.equal(audit[0]?.action, 'stock_move.reversed');

    const stored = await db.query('SELECT status FROM stock_moves WHERE tenant_id = $1 AND id = $2', [
      TENANT_OBRA,
      moveId,
    ]);
    assert.equal(stored.rowCount, 1, 'the reversed move is not deleted');
    assert.equal(stored.rows[0]?.status, 'reversed');
  });

  it('gerente creates a budget line and jefe_obra posts progress', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const line = await call('POST', '/v1/obras/progress/budget-lines', GERENTE, {
      siteId: obraAId,
      description: 'Muros de ladrillo',
      qtyPlanned: 100,
      unitCost: 25,
    });
    assert.equal(line.status, 201, JSON.stringify(line.body));
    budgetLineId = String(line.body.id);
    assert.equal((await auditByTraceEventually(line.traceId))[0]?.action, 'budget_line.created');

    const entry = await call('POST', '/v1/obras/progress/entries', JEFE, {
      siteId: obraAId,
      budgetLineId,
      qtyDone: 30,
    });
    assert.equal(entry.status, 201, JSON.stringify(entry.body));
    assert.equal(entry.body.status, 'posted');
    assert.equal(entry.body.reportedBy, U_JEFE);
    assert.equal((await auditByTraceEventually(entry.traceId))[0]?.action, 'progress_entry.posted');
  });

  it('adds up the posted progress of the site', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const second = await call('POST', '/v1/obras/progress/entries', JEFE, {
      siteId: obraAId,
      qtyDone: 12.5,
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const list = await call('GET', `/v1/obras/progress/entries?site=${obraAId}`, JEFE);
    assert.equal(list.status, 200);
    const entries = list.body as unknown as Record<string, unknown>[];
    const total = entries.reduce((sum, row) => sum + Number(row.qtyDone), 0);
    assert.equal(total, 42.5, JSON.stringify(entries));
  });

  it('publishes a site log from draft', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const created = await call('POST', `/v1/obras/sites/${obraAId}/logs`, JEFE, {
      text: 'Se vació el agregado en la losa',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'draft');
    siteLogId = String(created.body.id);
    assert.equal((await auditByTraceEventually(created.traceId))[0]?.action, 'site_log.created');

    const published = await call(
      'POST',
      `/v1/obras/sites/${obraAId}/logs/${siteLogId}/publish`,
      JEFE,
    );
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.status, 'published');
    assert.equal((await auditByTraceEventually(published.traceId))[0]?.action, 'site_log.published');
  });

  it('denies a worker creating a stock item', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/stock/items', WORKER, {
      sku: `SKU-${uniqueCode()}`,
      name: 'No permitido',
      unit: 'u',
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.scope_denied');
    assert.equal(result.body.reason, 'role.denied');
  });

  it('closing the assignment cuts access on the next decision', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const closed = await call('POST', `/v1/obras/sites/${obraAId}/staff/${U_WORKER}/close`, JEFE);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.active, false);
    assert.equal((await auditByTraceEventually(closed.traceId))[0]?.action, 'assignment.closed');

    const marked = await call('POST', '/v1/obras/attendance', WORKER, { siteId: obraAId });
    assert.equal(marked.status, 403);
    assert.equal(marked.body.code, 'obra.access_denied');
    assert.equal(marked.body.reason, 'no_active_assignment');

    const staff = await call('GET', `/v1/obras/sites/${obraAId}/staff`, WORKER);
    assert.equal(staff.status, 403);
    assert.equal(staff.body.code, 'obra.scope_denied');
    assert.equal(staff.body.reason, 'no_active_assignment');
  });

  it('imports workers from CSV with per-row errors', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const csv = [
      'name,email,role',
      'Obrero Uno,obrero.uno.e2e@example.invalid,trabajador',
      'Obrero Dos,obrero.dos.e2e@example.invalid,trabajador',
      'Duplicado,obrero.uno.e2e@example.invalid,trabajador',
    ].join('\n');
    const result = await call(
      'POST',
      '/v1/obras/imports/workers',
      GERENTE,
      { csv, orgNodeId: NODE_A },
      { 'idempotency-key': randomUUID() },
    );
    assert.equal(result.status, 201);
    assert.equal(result.body.rowsOk, 2);
    assert.equal(result.body.rowsError, 1);
  });

  it('imports assets from CSV with initial horometer', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const csv = [
      'code,kind,serial,horometer',
      'EQ-E2E-01,excavadora,SN-E2E-01,120.5',
    ].join('\n');
    const result = await call(
      'POST',
      '/v1/obras/imports/assets',
      GERENTE,
      { csv, orgNodeId: NODE_A },
      { 'idempotency-key': randomUUID() },
    );
    assert.equal(result.status, 201);
    assert.equal(result.body.rowsOk, 1);
    assert.equal(result.body.rowsError, 0);
  });

  it('serves the site board to the manager', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const board = await call('GET', `/v1/obras/sites/${obraAId}/board`, GERENTE);
    assert.equal(board.status, 200);
    assert.ok(board.body.progress !== undefined);
    assert.ok(board.body.attendance !== undefined);
  });

  it('serves the company board to the manager', async (t) => {
    if (!stackReady) return t.skip('local stack unavailable');
    const board = await call('GET', '/v1/obras/board', GERENTE);
    assert.equal(board.status, 200);
  });

  it('denies a worker without an assignment posting progress', async (t) => {
    if (!stackReady || obraAId === '') return t.skip('local stack unavailable');
    const result = await call('POST', '/v1/obras/progress/entries', WORKER, {
      siteId: obraAId,
      qtyDone: 1,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'obra.scope_denied');
    assert.equal(result.body.reason, 'no_active_assignment');
  });
});

/** Today (UTC) at the API's clock, used to query the day's attendance. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
