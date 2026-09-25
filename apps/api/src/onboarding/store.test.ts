// Onboarding setup store tests (peru-anexo-v1.md §11).
// Runs with node:test, no database: a fake client implements the minimal query
// surface and keeps the `onboarding_cases` / `app_state` / `onboarding_acta`
// tables in memory. The demo RUC is generated on the fly with its own SUNAT
// check digit (like `service.test.ts`); every other fixture is synthetic.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCheckDigit } from './ruc.ts';
import {
  actaPayloadOf,
  getOnboardingActa,
  getOnboardingResume,
  getOnboardingStatus,
  loadLatestCase,
  mapOnboardingCase,
  nextStepOf,
  parseOnboardingStep,
  readStepData,
  resolveCaseKey,
  submitOnboardingStep,
  type OnboardingDbClient,
} from './store.ts';

/** Synthetic demo RUC: base + its own SUNAT check digit. */
const DEMO_RUC = `2012345678${computeCheckDigit('2012345678')}`;

const ORGANIZER = {
  legalName: 'Clinica Demo Norte S.A.C.',
  ruc: DEMO_RUC,
  fiscalAddress: 'Av. Demo 123, Lima',
};
const SITES = {
  sites: [
    {
      name: 'Sede Demo Norte',
      address: 'Av. Demo 123, Lima',
      arcoEmail: 'arco.norte@example.invalid',
    },
  ],
};
const IDENTITY = { visibleName: 'Demo Salud', responsible: 'Dra. Demo Responsable' };
const BILLING = { mode: 'manual' };
const ADMIN = {
  username: 'admin.demo',
  email: 'admin.demo@example.invalid',
  mfaEnrolled: true,
};

function stepData(step: number): unknown {
  switch (step) {
    case 1:
      return ORGANIZER;
    case 2:
      return SITES;
    case 3:
      return IDENTITY;
    case 4:
      return BILLING;
    case 5:
      return ADMIN;
    case 6:
      return undefined;
    case 7:
      return { confirmed: true };
    default:
      throw new Error(`unknown step ${step}`);
  }
}

interface SnakeRow extends Record<string, unknown> {
  id: string;
  idempotency_key: string;
}

/** In-memory stand-in for the three migration-002 tables. */
class FakeDb implements OnboardingDbClient {
  cases: SnakeRow[] = [];
  initialized = false;
  actaRows: { case_id: string; hash: string; payload: unknown }[] = [];
  /** Rows committed by a concurrent writer: invisible to SELECT, hit INSERT. */
  ghosts = new Map<string, SnakeRow>();
  statements: string[] = [];
  private sequence = 0;

  async query(text: string, values: readonly unknown[] = []): Promise<unknown> {
    this.statements.push(text);
    if (text.startsWith('SELECT value FROM app_state')) {
      return { rows: this.initialized ? [{ value: '2026-09-25T10:00:00.000Z' }] : [] };
    }
    if (text.startsWith('SELECT id, idempotency_key, current_step')) {
      if (text.includes('WHERE idempotency_key = $1')) {
        const key = values[0] as string;
        const found =
          this.cases.find((row) => row.idempotency_key === key) ?? this.ghosts.get(key);
        return { rows: found === undefined ? [] : [{ ...found }] };
      }
      const ordered = [...this.cases].reverse();
      return { rows: ordered.slice(0, 1) };
    }
    if (text.startsWith('INSERT INTO onboarding_cases')) {
      const key = values[0] as string;
      if (this.cases.some((row) => row.idempotency_key === key) || this.ghosts.has(key)) {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      this.sequence += 1;
      const row: SnakeRow = {
        id: `00000000-0000-4000-8000-0000000000${String(this.sequence).padStart(2, '0')}`,
        idempotency_key: key,
        current_step: values[1],
        status: values[2],
        organizer: values[3],
        sites: values[4],
        identity: values[5],
        billing: values[6],
        admin_user: values[7],
        acta_hash: values[8],
        created_at: '2026-09-25T10:00:00.000Z',
        updated_at: '2026-09-25T10:00:00.000Z',
      };
      this.cases.push(row);
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('UPDATE onboarding_cases')) {
      const row = this.cases.find((candidate) => candidate.id === values[0]);
      if (row === undefined) return { rows: [] };
      row.current_step = values[1];
      row.status = values[2];
      row.organizer = values[3];
      row.sites = values[4];
      row.identity = values[5];
      row.billing = values[6];
      row.admin_user = values[7];
      row.acta_hash = values[8];
      return { rows: [{ ...row }] };
    }
    if (text.startsWith('INSERT INTO app_state')) {
      this.initialized = true;
      return { rows: [] };
    }
    if (text.startsWith('SELECT hash, payload')) {
      const rows = this.actaRows.filter((row) => row.case_id === values[0]);
      return { rows };
    }
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [] };
    }
    throw new Error(`unexpected statement: ${text}`);
  }
}

const NOW = '2026-09-25T10:00:00.000Z';
const TRACE = 'trace-demo-1';

function submit(
  db: FakeDb,
  step: number,
  key: string | undefined = 'alta-demo-0001',
  data: unknown = stepData(step),
) {
  return submitOnboardingStep(db, {
    stepRaw: String(step),
    body: { data, ...(key === undefined ? {} : { idempotencyKey: key }) },
    headerKey: undefined,
    now: NOW,
    traceId: TRACE,
  });
}

function responseOf(error: unknown): { status: number; code: string } {
  // NOTE: call through the object — detaching `getStatus`/`getResponse`
  // loses the receiver and throws inside `HttpException`.
  const candidate = error as { getStatus?: () => number; getResponse?: () => unknown };
  let status = -1;
  let body: { code?: unknown } = {};
  try {
    if (typeof candidate.getStatus === 'function') status = candidate.getStatus();
  } catch {
    status = -1;
  }
  try {
    if (typeof candidate.getResponse === 'function') {
      body = candidate.getResponse() as { code?: unknown };
    }
  } catch {
    body = {};
  }
  return { status, code: typeof body.code === 'string' ? body.code : '' };
}

describe('parseOnboardingStep / readStepData / resolveCaseKey', () => {
  it('accepts 1..7 and rejects anything else with onboarding.invalid_step', () => {
    assert.equal(parseOnboardingStep('3', TRACE), 3);
    for (const raw of ['0', '8', 'abc', '', undefined]) {
      assert.throws(() => parseOnboardingStep(raw, TRACE), (error: unknown) => {
        const { status, code } = responseOf(error);
        return status === 400 && code === 'onboarding.invalid_step';
      });
    }
  });

  it('reads the {data} envelope, including an absent review payload', () => {
    assert.deepEqual(readStepData({ data: ORGANIZER }), ORGANIZER);
    assert.equal(readStepData({}), undefined);
    assert.equal(readStepData(null), undefined);
  });

  it('prefers the header key, then the body key, then a fresh uuid', () => {
    assert.equal(resolveCaseKey('header-key', { idempotencyKey: 'body-key' }), 'header-key');
    assert.equal(resolveCaseKey(undefined, { idempotencyKey: 'body-key' }), 'body-key');
    assert.match(resolveCaseKey(undefined, {}), /^[0-9a-f-]{36}$/);
  });
});

describe('mapOnboardingCase / nextStepOf', () => {
  it('maps a snake_case row with JSONB columns onto the case shape', () => {
    const record = mapOnboardingCase({
      id: 'case-1',
      idempotency_key: 'alta-demo-0001',
      current_step: 2,
      status: 'active',
      organizer: JSON.stringify(ORGANIZER),
      sites: JSON.stringify(SITES.sites),
      identity: null,
      billing: null,
      admin_user: null,
      acta_hash: null,
      created_at: '2026-09-25T10:00:00.000Z',
      updated_at: '2026-09-25T10:00:00.000Z',
    });
    assert.equal(record.idempotencyKey, 'alta-demo-0001');
    assert.deepEqual(record.organizer, ORGANIZER);
    assert.deepEqual(record.sites, SITES.sites);
    assert.equal(nextStepOf(record), 2);
  });

  it('reports step 1 without a case and null once the case closed', () => {
    assert.equal(nextStepOf(null), 1);
    assert.equal(
      nextStepOf({ currentStep: 7, status: 'closed' } as ReturnType<typeof mapOnboardingCase>),
      null,
    );
  });

  it('rebuilds the signable payload the acta hashes', () => {
    const record = mapOnboardingCase({
      id: 'case-1',
      idempotency_key: 'alta-demo-0001',
      current_step: 7,
      status: 'closed',
      organizer: ORGANIZER,
      sites: SITES.sites,
      identity: IDENTITY,
      billing: BILLING,
      admin_user: ADMIN,
      acta_hash: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.deepEqual(actaPayloadOf(record), {
      organizer: ORGANIZER,
      sites: SITES.sites,
      identity: IDENTITY,
      billing: BILLING,
      adminUser: ADMIN,
      idempotencyKey: 'alta-demo-0001',
    });
  });
});

describe('status / resume reads', () => {
  it('reports an empty board before the first step', async () => {
    const db = new FakeDb();
    assert.deepEqual(await getOnboardingStatus(db), {
      initialized: false,
      case: null,
      nextStep: 1,
    });
    assert.equal(await loadLatestCase(db), null);
  });

  it('answers resume with 404 before the first step', async () => {
    const db = new FakeDb();
    await assert.rejects(getOnboardingResume(db, TRACE), (error: unknown) => {
      const { status, code } = responseOf(error);
      return status === 404 && code === 'onboarding.no_case';
    });
  });
});

describe('submit flow', () => {
  it('opens the case on step 1 and walks it to step 2', async () => {
    const db = new FakeDb();
    const first = await submit(db, 1);
    assert.equal(first.nextStep, 2);
    assert.equal(first.case.status, 'active');
    assert.deepEqual(first.case.organizer, ORGANIZER);
    assert.equal(first.acta, null);

    const status = await getOnboardingStatus(db);
    assert.equal(status.initialized, false);
    assert.equal(status.nextStep, 2);

    const resumed = await getOnboardingResume(db, TRACE);
    assert.equal(resumed.case?.currentStep, 2);
  });

  it('rejects a step submitted out of order', async () => {
    const db = new FakeDb();
    await submit(db, 1);
    await assert.rejects(submit(db, 3), (error: unknown) => {
      const { status, code } = responseOf(error);
      return status === 400 && code === 'onboarding.out_of_order';
    });
  });

  it('rejects an invalid payload with the service reason', async () => {
    const db = new FakeDb();
    await assert.rejects(
      submit(db, 1, 'alta-demo-0002', { ...ORGANIZER, ruc: '20123456780' }),
      (error: unknown) => {
        const { status, code } = responseOf(error);
        return status === 400 && code === 'onboarding.invalid_body';
      },
    );
    assert.equal(await loadLatestCase(db), null);
  });

  it('refuses to reopen step 1 once the case is open', async () => {
    const db = new FakeDb();
    await submit(db, 1);
    await assert.rejects(submit(db, 1), (error: unknown) => {
      const { status, code } = responseOf(error);
      return status === 400 && code === 'onboarding.out_of_order';
    });
  });

  it('collapses a concurrent open onto the existing case row', async () => {
    const db = new FakeDb();
    db.ghosts.set('alta-fantasma-1', {
      id: '00000000-0000-4000-8000-00000000ff01',
      idempotency_key: 'alta-fantasma-1',
      current_step: 2,
      status: 'active',
      organizer: JSON.stringify(ORGANIZER),
      sites: null,
      identity: null,
      billing: null,
      admin_user: null,
      acta_hash: null,
      created_at: NOW,
      updated_at: NOW,
    });
    const replayed = await submit(db, 1, 'alta-fantasma-1');
    assert.equal(replayed.case.idempotencyKey, 'alta-fantasma-1');
    assert.equal(replayed.nextStep, 2);
    assert.equal(db.cases.length, 0);
  });

  it('walks 1 -> 7, issues the acta and marks the app initialized', async () => {
    const db = new FakeDb();
    let current = await submit(db, 1);
    for (let step = 2; step <= 7; step++) {
      current = await submitOnboardingStep(db, {
        stepRaw: String(step),
        body: { data: stepData(step) },
        headerKey: undefined,
        now: NOW,
        traceId: TRACE,
      });
    }
    assert.equal(current.nextStep, null);
    assert.equal(current.case.status, 'closed');
    assert.match(current.acta?.hash ?? '', /^[0-9a-f]{64}$/);
    assert.match(current.case.actaHash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(current.acta?.hash, current.case.actaHash);

    const status = await getOnboardingStatus(db);
    assert.equal(status.initialized, true);
    assert.equal(status.nextStep, null);
    assert.ok(db.statements.includes('BEGIN'));
    assert.ok(db.statements.includes('COMMIT'));
  });

  it('locks the wizard once the run finished', async () => {
    const db = new FakeDb();
    for (let step = 1; step <= 7; step++) {
      await submitOnboardingStep(db, {
        stepRaw: String(step),
        body: { data: stepData(step), idempotencyKey: 'alta-demo-0001' },
        headerKey: undefined,
        now: NOW,
        traceId: TRACE,
      });
    }
    await assert.rejects(submit(db, 1), (error: unknown) => {
      const { status, code } = responseOf(error);
      return status === 409 && code === 'onboarding.already_initialized';
    });
    await assert.rejects(getOnboardingResume(db, TRACE), (error: unknown) => {
      const { code } = responseOf(error);
      return code === 'onboarding.closed';
    });
  });
});

describe('acta read', () => {
  it('answers 404 before any case and 409 while the wizard is open', async () => {
    const db = new FakeDb();
    await assert.rejects(getOnboardingActa(db, TRACE), (error: unknown) => {
      const { code } = responseOf(error);
      return code === 'onboarding.no_case';
    });
    await submit(db, 1);
    await assert.rejects(getOnboardingActa(db, TRACE), (error: unknown) => {
      const { status, code } = responseOf(error);
      return status === 409 && code === 'onboarding.not_completed';
    });
  });

  it('serves the signed payload of the closed case', async () => {
    const db = new FakeDb();
    let last = await submit(db, 1);
    for (let step = 2; step <= 7; step++) {
      last = await submitOnboardingStep(db, {
        stepRaw: String(step),
        body: { data: stepData(step) },
        headerKey: undefined,
        now: NOW,
        traceId: TRACE,
      });
    }
    const acta = await getOnboardingActa(db, TRACE);
    assert.equal(acta.hash, last.acta?.hash);
    assert.deepEqual(acta.payload.organizer, ORGANIZER);
    assert.deepEqual(acta.payload.sites, SITES.sites);
    assert.equal(acta.payload.idempotencyKey, 'alta-demo-0001');
  });

  it('prefers the onboarding_acta business row once a tenant persisted it', async () => {
    const db = new FakeDb();
    let last = await submit(db, 1);
    for (let step = 2; step <= 7; step++) {
      last = await submitOnboardingStep(db, {
        stepRaw: String(step),
        body: { data: stepData(step) },
        headerKey: undefined,
        now: NOW,
        traceId: TRACE,
      });
    }
    db.actaRows.push({
      case_id: last.case.id,
      hash: last.acta?.hash ?? '',
      payload: { ...(last.acta?.payload as Record<string, unknown>) },
    });
    const acta = await getOnboardingActa(db, TRACE);
    assert.equal(acta.hash, last.acta?.hash);
    assert.equal(acta.payload.idempotencyKey, 'alta-demo-0001');
  });
});
