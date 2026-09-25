// Liveness/readiness surface. `GET /health` is the probe used by the load
// balancer, the compose healthcheck and CI (bases-consolidadas-v1.md §7).
//
// A2 extends the A1 self-check with the two hard dependencies of the request
// contract (§4.2): Postgres (probed through the same PgBouncer pool the tenant
// middleware uses, so a PgBouncer outage is reported too) and Redis. The probe
// always answers 200 with a `status` field, so the caller decides whether
// `degraded` should take the instance out of rotation; consumers must treat
// `checks` as an open map and read it by key.
//
// Every dependency probe is bounded: a hung dependency reports `down` instead
// of holding the probe open, which is why both checks race a timeout.
import { Controller, Get, Header, Headers, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../tenant/tenant.middleware.ts';

/** Header used to correlate a probe/request with its logs and audit rows. */
export const TRACE_ID_HEADER = 'x-trace-id';

/** Injection token for the shared Redis client. */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Dependency state. */
export type CheckState = 'up' | 'down';

/** Per-dependency report; `checks` is an open map read by key. */
export interface HealthChecks {
  api: CheckState;
  postgres: CheckState;
  redis: CheckState;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: HealthChecks;
  traceId: string;
}

/** Upper bound for one dependency probe; keeps readiness answers bounded. */
const PROBE_TIMEOUT_MS = 1_000;

/**
 * Redis client for probes and (later) cache/queue usage. `lazyConnect` avoids a
 * connection at boot, `enableOfflineQueue: false` + `maxRetriesPerRequest: 1`
 * make a down Redis fail immediately instead of buffering commands, and
 * `retryStrategy: () => null` stops the background reconnect loop so a probe
 * reflects the state at probe time.
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: PROBE_TIMEOUT_MS,
    retryStrategy: () => null,
  });
  // A probe must not crash the process or flood the log when Redis is down:
  // the failure is reported by the `redis` check instead. Without a listener
  // ioredis treats its own `error` event as unhandled and prints it.
  client.on('error', () => undefined);
  return client;
}

/**
 * Races a probe against a timeout. The losing promise gets a no-op catch so a
 * late rejection cannot surface as an unhandled rejection.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe.timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  private readonly pool: Pool;
  private readonly redis: Redis;

  constructor(
    @Inject(PG_POOL) pool: Pool,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    this.pool = pool;
    this.redis = redis;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async health(@Headers(TRACE_ID_HEADER) traceId?: string): Promise<HealthResponse> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const checks: HealthChecks = { api: 'up', postgres, redis };
    return {
      status: Object.values(checks).every((state) => state === 'up') ? 'ok' : 'degraded',
      checks,
      traceId: traceId?.trim() || randomUUID(),
    };
  }

  /** `SELECT 1` through the request pool: proves Postgres *and* PgBouncer. */
  private async checkPostgres(): Promise<CheckState> {
    try {
      await withTimeout(this.pool.query('SELECT 1'), PROBE_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  /** `PING` against Redis 7. */
  private async checkRedis(): Promise<CheckState> {
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        await withTimeout(this.redis.connect(), PROBE_TIMEOUT_MS);
      }
      const reply = await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS);
      return reply === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
