// Workers entrypoint (P4-3b) — run with `node src/main.ts` (type stripping,
// no build) or `npm start`. Wires the production runtimes:
//
// - the `notify-send` BullMQ worker: outbox relay jobs plus the deferred 24h
//   appointment reminders (one delayed job per confirmed visit, dispatched by
//   job name inside `createNotifyWorker`). Every reminder fire re-checks the
//   live appointment status, renders in sede time through the log adapter,
//   and records one `sent` `message_log` row;
// - the release sweep repeatable (every 15 minutes): `scheduled` visits past
//   their start move to `cancelled` with one `appointment.released` audit row
//   each, and their leftover reminder job is dropped.
//
// Startup is fail-soft with a clear log: a missing `DATABASE_URL`/`REDIS_URL`
// or an unreachable Postgres/Redis prints what to set and exits non-zero
// instead of crashing with a bare stack. `SIGTERM`/`SIGINT` shut every
// worker, queue and pool down cleanly.
import { Pool } from 'pg';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { createNotifyAdapter, type NotifyAdapter, type NotifyAdapterKind } from './notify-adapter.ts';
import {
  NOTIFY_QUEUE,
  SELECT_APPOINTMENT_STATUS_SQL,
  createNotifyWorker,
} from './notify-send.ts';
import { reminderJobId } from './queues.ts';
import {
  RELEASE_SWEEP_EVERY_MS,
  RELEASE_SWEEP_JOB_NAME,
  RELEASE_SWEEP_QUEUE,
  runReleaseSweep,
} from './release-sweep.ts';

/** Environment the entrypoint reads (all plain strings, no secrets in code). */
function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Fails startup with a clear, actionable log instead of a bare stack. */
function fail(message: string): never {
  console.error(`[workers] ${message}`);
  process.exit(1);
}

/** Narrows an opaque `pg` result to its rows without extra types. */
function readRows(result: unknown): readonly Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function main(): Promise<void> {
  const databaseUrl = readEnv('DATABASE_URL');
  if (databaseUrl === '') {
    fail(
      'DATABASE_URL is not set — cannot reach Postgres. ' +
        'Set it (e.g. DATABASE_URL=postgresql://rizoma:rizoma_demo_password@postgres:5432/rizoma) and restart.',
    );
  }
  const redisUrl = readEnv('REDIS_URL');
  if (redisUrl === '') {
    fail(
      'REDIS_URL is not set — cannot reach Redis. ' +
        'Set it (e.g. REDIS_URL=redis://:rizoma_demo_password@redis:6379) and restart.',
    );
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    fail(
      `cannot reach Postgres at DATABASE_URL (${error instanceof Error ? error.message : String(error)}). ` +
        'Check the database is up and DATABASE_URL points at it.',
    );
  }
  console.log('[workers] postgres reachable');

  // One Redis connection per BullMQ object (BullMQ duplicates blocking
  // connections internally; sharing one instance across objects stalls).
  const openRedis = (): IORedis => {
    const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    redis.on('error', (error: Error) => {
      console.error(`[workers] redis error: ${error.message}`);
    });
    return redis;
  };
  const probe = openRedis();
  try {
    await probe.ping();
  } catch (error) {
    fail(
      `cannot reach Redis at REDIS_URL (${error instanceof Error ? error.message : String(error)}). ` +
        'Check Redis is up and REDIS_URL carries the right password.',
    );
  }
  await probe.quit();
  console.log('[workers] redis reachable');

  let adapter: NotifyAdapter;
  try {
    const kind = readEnv('NOTIFY_ADAPTER') === '' ? 'log' : readEnv('NOTIFY_ADAPTER');
    adapter = createNotifyAdapter(kind as NotifyAdapterKind);
  } catch (error) {
    fail(
      `cannot build the notify adapter (${error instanceof Error ? error.message : String(error)}). ` +
        'Set NOTIFY_ADAPTER=log for local/demo.',
    );
  }

  const sqlClient = {
    query: (text: string, values?: readonly unknown[]) =>
      pool.query(text, values === undefined ? [] : [...values]),
  };
  const loadAppointmentStatus = async (
    tenantId: string,
    appointmentId: string,
  ): Promise<string | null> => {
    const result = await pool.query(SELECT_APPOINTMENT_STATUS_SQL, [tenantId, appointmentId]);
    const status = readRows(result)[0]?.status;
    return typeof status === 'string' ? status : null;
  };

  const notifyQueue = new Queue(NOTIFY_QUEUE, { connection: openRedis() });
  const notifyWorker = await createNotifyWorker({
    connection: openRedis(),
    adapter,
    client: sqlClient,
    loadAppointmentStatus,
    onRetry: async (job, delaySeconds) => {
      await notifyQueue.add(NOTIFY_QUEUE, job, {
        delay: delaySeconds * 1000,
        attempts: 1,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        jobId: `${job.messageId}:${job.attempts + 1}`,
      });
    },
  });
  notifyWorker.on('failed', (job, error: Error) => {
    console.error(
      `[workers] notify-send job ${job?.id ?? 'unknown'} failed: ${error.message}`,
    );
  });
  console.log(`[workers] notify-send worker up (queue '${NOTIFY_QUEUE}', reminders by job name)`);

  const runSweepOnce = async (): Promise<void> => {
    try {
      const { released, checked } = await runReleaseSweep(sqlClient, {
        cancelReminder: async (appointmentId) => {
          const jobId = reminderJobId(appointmentId);
          const existing = await notifyQueue.getJob(jobId);
          if (existing !== undefined && existing !== null) await existing.remove();
        },
      });
      if (released.length > 0) {
        console.log(
          `[workers] release sweep: released ${released.length} visit(s) ` +
            `(${released.map((visit) => visit.id).join(', ')})`,
        );
      } else {
        console.log(`[workers] release sweep: checked ${checked}, nothing to release`);
      }
    } catch (error) {
      console.error(
        `[workers] release sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // The repeatable owns the cadence (survives restarts); the boot pass keeps
  // a fresh deploy from waiting a full interval for the first release.
  const sweepQueue = new Queue(RELEASE_SWEEP_QUEUE, { connection: openRedis() });
  await sweepQueue.add(RELEASE_SWEEP_JOB_NAME, {}, {
    repeat: { every: RELEASE_SWEEP_EVERY_MS },
    jobId: RELEASE_SWEEP_JOB_NAME,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  const sweepWorker = new Worker(
    RELEASE_SWEEP_QUEUE,
    async () => {
      await runSweepOnce();
      return { ok: true };
    },
    { connection: openRedis() },
  );
  sweepWorker.on('failed', (_job, error: Error) => {
    console.error(`[workers] release sweep job failed: ${error.message}`);
  });
  console.log(
    `[workers] release sweep repeatable every ${RELEASE_SWEEP_EVERY_MS / 60000} min`,
  );
  await runSweepOnce();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[workers] ${signal} received — shutting down`);
    await sweepWorker.close().catch(() => {});
    await notifyWorker.close().catch(() => {});
    await sweepQueue.close().catch(() => {});
    await notifyQueue.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

await main();
