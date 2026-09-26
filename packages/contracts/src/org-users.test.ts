// P2-0c contract coverage: org nodes + users listing schemas.
//
// Pins the PII-safe shapes the web selectors consume: org nodes carry
// id/parentId/kind/name/active, users carry id/name/email/orgNodeId/role/
// active and never phone or mfa_enrolled. Runner:
// `node --test src/org-users.test.ts` (type stripping).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ORG_NODE_KINDS,
  orgNodeKindSchema,
  orgNodeListSchema,
  orgNodePagedSchema,
  orgNodeRecordSchema,
} from './org.ts';
import { userListSchema, userPagedSchema, userRecordSchema } from './users.ts';

const NODE = {
  id: '11111111-1111-4111-8111-111111111111',
  parentId: null,
  kind: 'sede',
  name: 'Sede A',
  active: true,
};

const USER = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Médico Demo',
  email: 'medico@example.com',
  orgNodeId: '11111111-1111-4111-8111-111111111111',
  role: 'medico',
  active: true,
};

describe('org node schemas', () => {
  it('accepts a valid sede record', () => {
    assert.deepEqual(orgNodeRecordSchema.parse(NODE), NODE);
  });

  it('rejects an unknown kind in the kind filter schema', () => {
    assert.throws(() => orgNodeKindSchema.parse('nave'));
    assert.equal(orgNodeKindSchema.parse('sede'), 'sede');
  });

  it('knows the documented kinds', () => {
    for (const kind of ['empresa', 'sede', 'obra', 'especialidad']) {
      assert.ok(
        (ORG_NODE_KINDS as readonly string[]).includes(kind),
        `missing kind ${kind}`,
      );
    }
  });

  it('parses list and paged envelopes', () => {
    assert.deepEqual(orgNodeListSchema.parse([NODE]), [NODE]);
    const paged = orgNodePagedSchema.parse({ rows: [NODE], nextCursor: null });
    assert.equal(paged.rows.length, 1);
  });
});

describe('user schemas', () => {
  it('accepts a valid PII-safe record', () => {
    assert.deepEqual(userRecordSchema.parse(USER), USER);
  });

  it('strips phone and mfa_enrolled instead of accepting them', () => {
    const parsed = userRecordSchema.parse({
      ...USER,
      phone: '+51 999',
      mfa_enrolled: true,
    });
    assert.ok(!('phone' in parsed), 'phone must not survive parsing');
    assert.ok(
      !('mfa_enrolled' in parsed),
      'mfa_enrolled must not survive parsing',
    );
  });

  it('parses list and paged envelopes', () => {
    assert.deepEqual(userListSchema.parse([USER]), [USER]);
    const paged = userPagedSchema.parse({ rows: [USER], nextCursor: 'abc' });
    assert.equal(paged.nextCursor, 'abc');
  });
});
