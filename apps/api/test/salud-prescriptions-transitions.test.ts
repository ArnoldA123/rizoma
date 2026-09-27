// Prescription transition coverage (P4-2a: Emitir / Anular): the closed
// `draft → issued / cancelled` machine over `state_transitions` (entity
// `prescription`, migration 011), the `open`-episode gate and the
// `episode.write` guard.
//
// The SQL client is a small stateful in-memory double: it answers the guard
// facts (membership, subtree, modules), holds the episode and prescription
// rows, and emulates the catalog from the 011 seed. All data is synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  transitionPrescription,
  type PrescriptionRecord,
} from '../src/salud/prescriptions.service.ts';
import type { ActorContext, SaludClient } from '../src/salud/salud.service.ts';

// ============ synthetic fixtures ============

const TENANT_ID = 'a3000000-0000-4000-8000-0000000000aa';
const SEDE_A = 'b3000000-0000-4000-8000-0000000000a1';
const USER_MEDICO = 'c3000000-0000-4000-8000-0000000000a1';
const USER_ENFERMERIA = 'c3000000-0000-4000-8000-0000000000a2';
const USER_CAJA = 'c3000000-0000-4000-8000-0000000000a3';
const MEMBERSHIP_ID = 'd3000000-0000-4000-8000-0000000000a1';
const PATIENT_ID = 'e3000000-0000-4000-8000-0000000000a1';
const EPISODE_ID = 'f3000000-0000-4000-8000-0000000000a1';
const PRESCRIPTION_ID = 'aa300000-0000-4000-8000-0000000000a1';
const TRACE = 'trace-prescription-transition-1';

/** Closed machine seed, mirroring migration 011. */
const CATALOG: readonly { from: string; to: string; roles: string[] }[] = [
  { from: 'draft', to: 'issued', roles: ['medico'] },
  { from: 'draft', to: 'cancelled', roles: ['medico'] },
];

function membershipRow(role: string, userId: string): Record<string, unknown> {
  return {
    id: MEMBERSHIP_ID,
    user_id: userId,
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

function prescriptionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PRESCRIPTION_ID,
    tenant_id: TENANT_ID,
    patient_id: PATIENT_ID,
    episode_id: EPISODE_ID,
    template_code: 'receta.general',
    items: [{ description: 'Amoxicilina 500 mg', quantity: 21 }],
    status: 'draft',
    ...overrides,
  };
}

function episodeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EPISODE_ID,
    patient_id: PATIENT_ID,
    status: 'open',
    org_node_id: SEDE_A,
    ...overrides,
  };
}

// ============ stateful in-memory double ============

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDb {
  readonly client: SaludClient;
  readonly queries: RecordedQuery[];
}

function createDb(options: {
  readonly role: string;
  readonly userId: string;
  readonly prescription?: Record<string, unknown> | null;
  readonly episode?: Record<string, unknown> | null;
}): FakeDb {
  const queries: RecordedQuery[] = [];
  let stored: Record<string, unknown> | null =
    options.prescription === undefined
      ? prescriptionRow()
      : options.prescription === null
        ? null
        : { ...options.prescription };
  const episode =
    options.episode === undefined ? episodeRow() : options.episode === null ? null : options.episode;
  const client: SaludClient = {
    async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
      queries.push({ text, values });
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      if (text.includes('FROM memberships')) {
        return { rows: [membershipRow(options.role, options.userId)] };
      }
      if (text.includes('WITH RECURSIVE subtree')) return { rows: [{ id: SEDE_A }] };
      if (text.includes('FROM tenants')) return { rows: [{ modules: ['crm-core', 'salud'] }] };
      if (text.includes('FROM state_transitions')) {
        const [, , from, to] = values as [string, string, string, string];
        const seed = CATALOG.find((entry) => entry.from === from && entry.to === to);
        return { rows: seed === undefined ? [] : [{ allowed_roles: seed.roles }] };
      }
      if (text.includes('UPDATE prescriptions')) {
        if (stored === null) return { rows: [] };
        stored = { ...stored, status: values[2] };
        return { rows: [{ ...stored }] };
      }
      if (text.includes('FROM prescriptions')) {
        return { rows: stored === null ? [] : [{ ...stored }] };
      }
      if (text.includes('JOIN patient_files')) {
        return { rows: episode === null ? [] : [{ ...episode }] };
      }
      return { rows: [] };
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

function actor(db: FakeDb, userId: string): ActorContext {
  return {
    client: db.client,
    tenantId: TENANT_ID,
    userId,
    roles: [],
    traceId: TRACE,
    ip: null,
  };
}

function writes(db: FakeDb): { action: string; diff: Record<string, unknown> }[] {
  return audits(db).filter((entry) => !entry.action.startsWith('access.'));
}

describe('transitionPrescription', () => {
  it('lets the medico Emitir a draft order of an open episode', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO });
    const issued: PrescriptionRecord = await transitionPrescription(
      actor(db, USER_MEDICO),
      PRESCRIPTION_ID,
      'issued',
    );

    assert.equal(issued.status, 'issued');
    const trail = writes(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'prescription.issued');
    assert.deepEqual(trail[0]?.diff, {
      traceId: TRACE,
      from: 'draft',
      to: 'issued',
      episodeId: EPISODE_ID,
      patientId: PATIENT_ID,
    });
  });

  it('lets the medico Anular a draft order', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO });
    const cancelled = await transitionPrescription(actor(db, USER_MEDICO), PRESCRIPTION_ID, 'cancelled');

    assert.equal(cancelled.status, 'cancelled');
    const trail = writes(db);
    assert.equal(trail.length, 1);
    assert.equal(trail[0]?.action, 'prescription.cancelled');
  });

  it('refuses a target outside the pair with 400', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO });
    await assert.rejects(
      async () => transitionPrescription(actor(db, USER_MEDICO), PRESCRIPTION_ID, 'draft'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 400 && http.body.code === 'validation.failed';
      },
    );
    await assert.rejects(
      async () => transitionPrescription(actor(db, USER_MEDICO), PRESCRIPTION_ID, 'signed'),
      (error: unknown) => httpError(error)?.status === 400,
    );
  });

  it('refuses a move out of an issued order with 403', async () => {
    const db = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      prescription: prescriptionRow({ status: 'issued' }),
    });
    await assert.rejects(
      async () => transitionPrescription(actor(db, USER_MEDICO), PRESCRIPTION_ID, 'cancelled'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('refuses a draft of a closed episode with 403', async () => {
    const db = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      episode: episodeRow({ status: 'closed' }),
    });
    await assert.rejects(
      async () => transitionPrescription(actor(db, USER_MEDICO), PRESCRIPTION_ID, 'issued'),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 403 && http.body.code === 'access.denied';
      },
    );
    assert.equal(writes(db).length, 0);
  });

  it('denies enfermeria and caja with 403', async () => {
    for (const [role, userId] of [
      ['enfermeria', USER_ENFERMERIA],
      ['caja', USER_CAJA],
    ] as const) {
      const db = createDb({ role, userId });
      await assert.rejects(
        async () => transitionPrescription(actor(db, userId), PRESCRIPTION_ID, 'issued'),
        (error: unknown) => {
          const http = httpError(error);
          return http?.status === 403 && http.body.code === 'access.denied';
        },
        `${role} must not transition a prescription`,
      );
      assert.equal(writes(db).length, 0);
    }
  });

  it('answers 404 for an unknown prescription', async () => {
    const db = createDb({ role: 'medico', userId: USER_MEDICO, prescription: null });
    await assert.rejects(
      async () =>
        transitionPrescription(
          actor(db, USER_MEDICO),
          'bb300000-0000-4000-8000-0000000000b1',
          'issued',
        ),
      (error: unknown) => {
        const http = httpError(error);
        return http?.status === 404 && http.body.code === 'not_found';
      },
    );
  });

  it('returns the row untouched when the status is already set', async () => {
    const db = createDb({
      role: 'medico',
      userId: USER_MEDICO,
      prescription: prescriptionRow({ status: 'issued' }),
    });
    const same = await transitionPrescription(actor(db, USER_MEDICO), PRESCRIPTION_ID, 'issued');

    assert.equal(same.status, 'issued');
    assert.equal(writes(db).length, 0, 'an idempotent move audits nothing');
  });
});
