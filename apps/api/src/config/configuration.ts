// Runtime configuration — environment contract for the API process
// (bases-consolidadas-v1.md §1.2: Postgres 16 behind PgBouncer, Redis 7 for
// cache/queues, Keycloak 25+ OIDC, S3-compatible object storage).
//
// Design rules:
// - Pure module: it reads a plain env record, never `process.env` directly, so
//   it can be exercised without a Nest container and without side effects.
// - `DATABASE_URL` is mandatory. `validate` fails fast on the raw environment;
//   the process must not start against a half-wired database binding.
// - Every other key carries a synthetic local default mirroring `.env.example`.
//   Those values are demo-only and must never be reused outside local dev.
// - Request-time queries go through PgBouncer in transaction mode (§4.2):
//   when `DATABASE_URL_PGBOUNCER` is absent it falls back to `DATABASE_URL`.

/** Injection token for the resolved, validated configuration object. */
export const CONFIG_TOKEN = 'API_CONFIG';

/** Environment shape accepted by this module (a plain `process.env` record). */
export type EnvRecord = Record<string, string | undefined>;

export interface ApiConfig {
  /** HTTP port the API binds to (loopback only; the proxy owns ingress). */
  readonly port: number;
  /** Direct Postgres connection: migrations and administrative tasks. */
  readonly databaseUrl: string;
  /** Transaction-pooled Postgres connection used by request-time queries. */
  readonly databaseUrlPgbouncer: string;
  /** Redis 7 connection (cache, BullMQ queues, revocation TTLs in A4). */
  readonly redisUrl: string;
  /** Keycloak base URL backing OIDC discovery. */
  readonly keycloakUrl: string;
  /** Keycloak realm this deployment authenticates against. */
  readonly keycloakRealm: string;
  /** S3-compatible endpoint (R2 in production, MinIO/LocalStack locally). */
  readonly s3Endpoint: string;
}

/**
 * Configuration failure. Carries the machine-readable `code` used by the
 * error envelope convention (`{code, message, traceId}`); the caller adds the
 * `traceId` because boot-time failures happen before a request context exists.
 */
export class ConfigError extends Error {
  readonly code = 'config.invalid';

  constructor(
    message: string,
    readonly variable: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Synthetic local defaults (demo credentials only — see `.env.example`). */
export const LOCAL_DEFAULTS = {
  PORT: '3001',
  REDIS_URL: 'redis://:rizoma_demo_password@localhost:6379',
  KEYCLOAK_URL: 'http://localhost:8080',
  KEYCLOAK_REALM: 'rizoma',
  S3_ENDPOINT: 'http://localhost:4566',
} as const;

/** Reads a variable, treating blank strings as absent, then applying fallback. */
function readString(env: EnvRecord, key: string, fallback?: string): string {
  const raw = env[key];
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  if (value === undefined || value === '') {
    throw new ConfigError(`Missing required environment variable: ${key}`, key);
  }
  return value;
}

/** Parses a TCP port, rejecting non-integers and out-of-range values. */
function readPort(env: EnvRecord): number {
  const raw = readString(env, 'PORT', LOCAL_DEFAULTS.PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid PORT (expected an integer 1-65535): ${raw}`, 'PORT');
  }
  return port;
}

/**
 * Minimal fail-fast check over the raw environment. Only invariants that make
 * the process unusable are enforced here; dependency reachability (Postgres,
 * Redis, Keycloak) is reported by the A2 health checks, not by this function.
 */
export function validate(env: EnvRecord): void {
  readString(env, 'DATABASE_URL');
}

/**
 * Validates and resolves the environment into a frozen, typed config object.
 * Throws {@link ConfigError} on the first broken variable.
 */
export function load(env: EnvRecord = {}): ApiConfig {
  validate(env);
  return Object.freeze<ApiConfig>({
    port: readPort(env),
    databaseUrl: readString(env, 'DATABASE_URL'),
    databaseUrlPgbouncer: readString(
      env,
      'DATABASE_URL_PGBOUNCER',
      readString(env, 'DATABASE_URL'),
    ),
    redisUrl: readString(env, 'REDIS_URL', LOCAL_DEFAULTS.REDIS_URL),
    keycloakUrl: readString(env, 'KEYCLOAK_URL', LOCAL_DEFAULTS.KEYCLOAK_URL),
    keycloakRealm: readString(env, 'KEYCLOAK_REALM', LOCAL_DEFAULTS.KEYCLOAK_REALM),
    s3Endpoint: readString(env, 'S3_ENDPOINT', LOCAL_DEFAULTS.S3_ENDPOINT),
  });
}
