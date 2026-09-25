// File contract tests — signed S3 upload/download (H2, bases §4.5).
//
// The schemas accept the exact shapes `files.service.ts` emits and refuse the
// security-relevant negatives: a module outside the closed list, an oversized
// payload, a malformed digest, and — load-bearing — an `expiresIn` above the
// 5-minute cap. Synthetic data only. Runner: `node --test src/files.test.ts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FILE_MODULES,
  FILE_SIZE_LIMIT_BYTES,
  FILE_URL_TTL_SECONDS,
  fileDownloadResponseSchema,
  fileModuleSchema,
  fileUploadRequestSchema,
  fileUploadResponseSchema,
} from './files.ts';

const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `tenant/${TENANT_ID}/salud/2026/03/${ATTACHMENT_ID}`;
const SHA256 = 'a'.repeat(64);

describe('fileModuleSchema', () => {
  it('accepts every closed-list module', () => {
    for (const module of FILE_MODULES) {
      assert.equal(fileModuleSchema.parse(module), module);
    }
  });

  it('rejects a module outside the closed list', () => {
    assert.throws(() => fileModuleSchema.parse('contabilidad'));
    assert.throws(() => fileModuleSchema.parse(''));
  });
});

describe('fileUploadRequestSchema', () => {
  it('accepts a well-formed upload request with an optional digest', () => {
    const parsed = fileUploadRequestSchema.parse({
      module: 'salud',
      mime: 'application/pdf',
      sizeBytes: 1024,
      sha256: SHA256,
    });
    assert.equal(parsed.module, 'salud');
    assert.equal(parsed.sha256, SHA256);
  });

  it('accepts a request without a digest (hash unknown before the PUT)', () => {
    const parsed = fileUploadRequestSchema.parse({
      module: 'obras',
      mime: 'image/jpeg',
      sizeBytes: 512,
    });
    assert.equal(parsed.sha256, undefined);
  });

  it('rejects an oversized payload and a non-positive one', () => {
    const base = { module: 'salud', mime: 'application/pdf' };
    assert.throws(() =>
      fileUploadRequestSchema.parse({ ...base, sizeBytes: FILE_SIZE_LIMIT_BYTES + 1 }),
    );
    assert.throws(() => fileUploadRequestSchema.parse({ ...base, sizeBytes: 0 }));
    assert.throws(() => fileUploadRequestSchema.parse({ ...base, sizeBytes: -1 }));
  });

  it('rejects a malformed digest', () => {
    assert.throws(() =>
      fileUploadRequestSchema.parse({
        module: 'salud',
        mime: 'application/pdf',
        sizeBytes: 8,
        sha256: 'not-a-digest',
      }),
    );
  });
});

describe('fileUploadResponseSchema', () => {
  it('accepts the exact shape the service emits', () => {
    const parsed = fileUploadResponseSchema.parse({
      attachmentId: ATTACHMENT_ID,
      bucketKey: KEY,
      uploadUrl: 'http://localhost:4566/rizoma-local/tenant/x?X-Amz-Expires=300',
      expiresIn: 300,
      mime: 'application/pdf',
      sizeBytes: 1024,
    });
    assert.equal(parsed.attachmentId, ATTACHMENT_ID);
    assert.equal(parsed.bucketKey, KEY);
  });

  it('rejects a signed URL life above the 5-minute cap', () => {
    assert.equal(FILE_URL_TTL_SECONDS, 300);
    assert.throws(() =>
      fileUploadResponseSchema.parse({
        attachmentId: ATTACHMENT_ID,
        bucketKey: KEY,
        uploadUrl: 'http://localhost:4566/rizoma-local/tenant/x',
        expiresIn: 301,
        mime: 'application/pdf',
        sizeBytes: 1024,
      }),
    );
  });
});

describe('fileDownloadResponseSchema', () => {
  it('accepts the exact shape the service emits', () => {
    const parsed = fileDownloadResponseSchema.parse({
      attachmentId: ATTACHMENT_ID,
      bucketKey: KEY,
      downloadUrl: 'http://localhost:4566/rizoma-local/tenant/x?X-Amz-Expires=300',
      expiresIn: 300,
      mime: 'application/pdf',
      sizeBytes: 1024,
    });
    assert.equal(parsed.downloadUrl.includes('http'), true);
  });

  it('rejects a download URL life above the 5-minute cap', () => {
    assert.throws(() =>
      fileDownloadResponseSchema.parse({
        attachmentId: ATTACHMENT_ID,
        bucketKey: KEY,
        downloadUrl: 'http://localhost:4566/rizoma-local/tenant/x',
        expiresIn: 3600,
        mime: 'application/pdf',
        sizeBytes: 1024,
      }),
    );
  });

  it('rejects a non-URL download target (never a bare key or path)', () => {
    assert.throws(() =>
      fileDownloadResponseSchema.parse({
        attachmentId: ATTACHMENT_ID,
        bucketKey: KEY,
        downloadUrl: KEY,
        expiresIn: 300,
        mime: 'application/pdf',
        sizeBytes: 1024,
      }),
    );
  });
});
