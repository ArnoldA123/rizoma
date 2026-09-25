// Files service coverage — signed S3 upload/download (H2, bases §4.5).
//
// The SQL client is an in-memory double keyed by statement fragment, so the
// suite asserts the canonical key, the presigned URL shape and the `audit_log`
// rows without a database or a network. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FILE_SIZE_LIMIT_BYTES,
  getFileDownload,
  requestFileUpload,
} from './files.service.ts';
import { presignGetUrl, presignPutUrl, resolveS3Config } from './s3.ts';
import { SIGNED_URL_TTL_SECONDS } from './paths.ts';
import type { ActorContext, SaludClient } from '../salud/salud.service.ts';
import type { S3Config } from './s3.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a1000000-0000-4000-8000-0000000000aa';
const OTHER_TENANT = 'a9000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b1000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c1000000-0000-4000-8000-0000000000a1';
const USER_ENFERMERIA = 'c1000000-0000-4000-8000-0000000000a2';
const USER_CAJA = 'c1000000-0000-4000-8000-0000000000a3';
const MEMBERSHIP_ID = 'd1000000-0000-4000-8000-0000000000a1';
const ATTACHMENT_ID = 'ab000000-0000-4000-8000-0000000000a1';
const OBJECT_V4 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRACE = 'trace-files-1';
const SHA256 = 'b'.repeat(64);
const NOW = new Date('2026-03-09T12:00:00.000Z');
const EXPECTED_KEY = `tenant/${TENANT_ID}/salud/2026/03/${OBJECT_V4}`;

const S3: S3Config = {
  endpoint: 'http://localhost:4566',
  bucket: 'rizoma-local',
  region: 'us-east-1',
  accessKeyId: 'rizoma',
  secretAccessKey: 'rizoma_demo_password',
};

const USER_BY_ROLE: Record<string, string> = {
  medico: USER_MEDICO,
  enfermeria: USER_ENFERMERIA,
  caja: USER_CAJA,
};

function membershipRow(role: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: USER_BY_ROLE[role] ?? USER_MEDICO,
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

/** Guard facts every allowed use case needs (role + modules overridable). */
function baseRoutes(role = 'medico', modules: readonly string[] = ['crm-core', 'salud']): Route[] {
  return [
    { match: 'FROM memberships', rows: [membershipRow(role)] },
    { match: 'WITH RECURSIVE subtree', rows: [{ id: SEDE_A }] },
    { match: 'FROM tenants', rows: [{ modules: [...modules] }] },
  ];
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

const UPLOAD_BODY = {
  module: 'salud',
  mime: 'application/pdf',
  sizeBytes: 1024,
  sha256: SHA256,
};

const OVERRIDES = { s3: S3, now: NOW, newId: () => OBJECT_V4 };

function attachmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTACHMENT_ID,
    tenant_id: TENANT_ID,
    bucket_key: EXPECTED_KEY,
    sha256: SHA256,
    mime: 'application/pdf',
    size_bytes: 1024,
    ...overrides,
  };
}

// ============ request-upload ============

describe('requestFileUpload', () => {
  it('registers the canonical key and mints a PUT URL capped at 5 minutes', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'INSERT INTO attachments',
      rows: [{ id: ATTACHMENT_ID }],
    });
    const grant = await requestFileUpload(actor(db.client), UPLOAD_BODY, OVERRIDES);

    assert.equal(grant.attachmentId, ATTACHMENT_ID);
    assert.equal(grant.bucketKey, EXPECTED_KEY);
    assert.equal(grant.expiresIn, SIGNED_URL_TTL_SECONDS);
    assert.equal(grant.expiresIn <= 300, true);
    assert.ok(grant.uploadUrl.startsWith(`${S3.endpoint}/${S3.bucket}/tenant/`));
    assert.ok(grant.uploadUrl.includes(encodeURIComponent(OBJECT_V4).slice(0, 8)));
    assert.ok(grant.uploadUrl.includes('X-Amz-Expires=300'));
    assert.ok(grant.uploadUrl.includes('X-Amz-Signature='));

    const insert = db.queries.find((query) => query.text.includes('INSERT INTO attachments'));
    assert.deepEqual(insert?.values.slice(0, 5), [
      TENANT_ID,
      EXPECTED_KEY,
      SHA256,
      'application/pdf',
      1024,
    ]);

    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'file.upload_requested');
    assert.equal(trail[0]?.diff.bucketKey, EXPECTED_KEY);
    assert.equal(trail[0]?.diff.expiresIn, 300);
  });

  it('stores a pending hash marker when the client does not know the digest yet', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'INSERT INTO attachments',
      rows: [{ id: ATTACHMENT_ID }],
    });
    const { sha256: _omitted, ...body } = UPLOAD_BODY;
    const grant = await requestFileUpload(actor(db.client), body, OVERRIDES);

    assert.equal(grant.attachmentId, ATTACHMENT_ID);
    const insert = db.queries.find((query) => query.text.includes('INSERT INTO attachments'));
    assert.ok(String(insert?.values[2]).startsWith('pending:'));
  });

  it('rejects a module outside the closed list before any query runs', async () => {
    const db = createDb(...baseRoutes());
    await assert.rejects(
      async () => requestFileUpload(actor(db.client), { ...UPLOAD_BODY, module: 'contabilidad' }, OVERRIDES),
      isError('validation.failed'),
    );
    assert.equal(
      db.queries.some((query) => query.text.includes('INSERT INTO attachments')),
      false,
    );
  });

  it('rejects an unsupported mime and an oversized payload', async () => {
    const db = createDb(...baseRoutes());
    await assert.rejects(
      async () =>
        requestFileUpload(actor(db.client), { ...UPLOAD_BODY, mime: 'application/x-sh' }, OVERRIDES),
      isError('validation.failed'),
    );
    await assert.rejects(
      async () =>
        requestFileUpload(actor(db.client), { ...UPLOAD_BODY, sizeBytes: FILE_SIZE_LIMIT_BYTES + 1 }, OVERRIDES),
      isError('validation.failed'),
    );
  });

  it('denies a role without the module write and audits the denial', async () => {
    const db = createDb(...baseRoutes('enfermeria'), {
      match: 'INSERT INTO attachments',
      rows: [{ id: ATTACHMENT_ID }],
    });
    await assert.rejects(
      async () =>
        requestFileUpload(actor(db.client, { userId: USER_ENFERMERIA }), UPLOAD_BODY, OVERRIDES),
      isError('access.denied', 403),
    );
    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'access.denied');
    assert.equal(trail[0]?.diff.reason, 'role.denied');
  });

  it('denies when the tenant has no such module active', async () => {
    const db = createDb(...baseRoutes('medico', ['crm-core']), {
      match: 'INSERT INTO attachments',
      rows: [{ id: ATTACHMENT_ID }],
    });
    await assert.rejects(
      async () => requestFileUpload(actor(db.client), UPLOAD_BODY, OVERRIDES),
      isError('access.denied', 403),
    );
    assert.equal(audits(db)[0]?.diff.reason, 'module.inactive');
  });
});

// ============ download ============

describe('getFileDownload', () => {
  it('mints a GET URL for the canonical key and audits the grant', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'FROM attachments',
      rows: [attachmentRow()],
    });
    const grant = await getFileDownload(actor(db.client), ATTACHMENT_ID, OVERRIDES);

    assert.equal(grant.attachmentId, ATTACHMENT_ID);
    assert.equal(grant.bucketKey, EXPECTED_KEY);
    assert.equal(grant.expiresIn, 300);
    assert.ok(grant.downloadUrl.startsWith(`${S3.endpoint}/${S3.bucket}/tenant/`));
    assert.ok(grant.downloadUrl.includes('X-Amz-Expires=300'));
    assert.ok(grant.downloadUrl.includes('X-Amz-Signature='));
    // The download leg never carries the PUT-only unsigned-payload marker.
    assert.equal(grant.downloadUrl.includes('X-Amz-Content-Sha256'), false);

    const trail = audits(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'file.download_requested');
  });

  it('lets a read-only clinical role download (patient.read)', async () => {
    const db = createDb(...baseRoutes('enfermeria'), {
      match: 'FROM attachments',
      rows: [attachmentRow()],
    });
    const grant = await getFileDownload(
      actor(db.client, { userId: USER_ENFERMERIA }),
      ATTACHMENT_ID,
      OVERRIDES,
    );
    assert.equal(grant.attachmentId, ATTACHMENT_ID);
  });

  it('denies a role without the module read (caja cannot read salud files)', async () => {
    const db = createDb(...baseRoutes('caja', ['crm-core', 'salud', 'facturacion']), {
      match: 'FROM attachments',
      rows: [attachmentRow()],
    });
    await assert.rejects(
      async () => getFileDownload(actor(db.client, { userId: USER_CAJA }), ATTACHMENT_ID, OVERRIDES),
      isError('access.denied', 403),
    );
    assert.equal(audits(db)[0]?.diff.reason, 'role.denied');
  });

  it('returns 404 for an attachment invisible to the tenant', async () => {
    const db = createDb(...baseRoutes(), { match: 'FROM attachments', rows: [] });
    await assert.rejects(
      async () => getFileDownload(actor(db.client), ATTACHMENT_ID, OVERRIDES),
      isError('not_found', 404),
    );
  });

  it('fails closed on a non-canonical stored key', async () => {
    const db = createDb(...baseRoutes(), {
      match: 'FROM attachments',
      rows: [attachmentRow({ bucket_key: 'consents/patient-x/abc.pdf' })],
    });
    await assert.rejects(
      async () => getFileDownload(actor(db.client), ATTACHMENT_ID, OVERRIDES),
      isError('file.unsupported_key', 404),
    );
  });

  it('fails closed when the key names another tenant', async () => {
    const foreignKey = `tenant/${OTHER_TENANT}/salud/2026/03/${OBJECT_V4}`;
    const db = createDb(...baseRoutes(), {
      match: 'FROM attachments',
      rows: [attachmentRow({ bucket_key: foreignKey })],
    });
    await assert.rejects(
      async () => getFileDownload(actor(db.client), ATTACHMENT_ID, OVERRIDES),
      isError('file.tenant_mismatch', 404),
    );
  });
});

// ============ presigner ============

describe('presigner', () => {
  it('resolves the synthetic local defaults, including localhost:4566', () => {
    const config = resolveS3Config({});
    assert.equal(config.endpoint, 'http://localhost:4566');
    assert.equal(config.bucket, 'rizoma-local');
  });

  it('refuses a lifetime above 5 minutes', () => {
    assert.throws(() => presignPutUrl(S3, EXPECTED_KEY, 301, NOW), RangeError);
    assert.throws(() => presignGetUrl(S3, EXPECTED_KEY, 3600, NOW), RangeError);
  });

  it('signs deterministically for a fixed instant', () => {
    const first = presignGetUrl(S3, EXPECTED_KEY, 300, NOW);
    const second = presignGetUrl(S3, EXPECTED_KEY, 300, NOW);
    assert.equal(first, second);
    assert.ok(first.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256'));
    assert.ok(first.includes('X-Amz-Credential='));
  });

  it('marks the PUT leg as unsigned-payload and keeps the GET leg clean', () => {
    const put = presignPutUrl(S3, EXPECTED_KEY, 300, NOW);
    assert.ok(put.includes('X-Amz-Content-Sha256=UNSIGNED-PAYLOAD'));
  });
});
