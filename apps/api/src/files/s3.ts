// Minimal S3-compatible presigner (H2, bases-consolidadas-v1.md §4.5).
//
// Deliberately dependency-free: the API has no AWS SDK, so this module signs
// SigV4 query-auth URLs by hand with `node:crypto` — the smallest surface that
// LocalStack, MinIO and R2 all accept. Pure by design: no clock, no I/O, no
// `process.env` reads. `resolveS3Config` adapts a plain env record (with the
// synthetic local defaults of `.env.example`); the service injects the result,
// and `node --test` exercises everything without a network or a container.
//
// URL style is path-style (`{endpoint}/{bucket}/{key}`): it works unchanged
// against LocalStack/MinIO and R2. Both methods sign only the `host` header,
// so the browser PUT sends the declared `Content-Type` unsigned. The lifetime
// is capped at 5 minutes and `presignUrl` refuses anything above it.
import { createHash, createHmac } from 'node:crypto';
import { SIGNED_URL_TTL_SECONDS } from './paths.ts';

/** Everything needed to address and sign one S3-compatible bucket. */
export interface S3Config {
  /** Base endpoint, e.g. `http://localhost:4566` (no trailing slash). */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Plain env record (`process.env` satisfies it). */
export type EnvRecord = Record<string, string | undefined>;

/** Synthetic local defaults mirroring `.env.example` (demo-only values). */
export const S3_LOCAL_DEFAULTS = {
  S3_ENDPOINT: 'http://localhost:4566',
  S3_BUCKET: 'rizoma-local',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'rizoma',
  S3_SECRET_ACCESS_KEY: 'rizoma_demo_password',
} as const;

function readValue(env: EnvRecord, key: string, fallback: string): string {
  const raw = env[key];
  const value = raw === undefined || raw.trim() === '' ? fallback : raw.trim();
  if (key === 'S3_ENDPOINT') return value.replace(/\/+$/, '');
  return value;
}

/** Resolves the bucket binding from a plain env record (pure, testable). */
export function resolveS3Config(env: EnvRecord = {}): S3Config {
  return {
    endpoint: readValue(env, 'S3_ENDPOINT', S3_LOCAL_DEFAULTS.S3_ENDPOINT),
    bucket: readValue(env, 'S3_BUCKET', S3_LOCAL_DEFAULTS.S3_BUCKET),
    region: readValue(env, 'S3_REGION', S3_LOCAL_DEFAULTS.S3_REGION),
    accessKeyId: readValue(env, 'S3_ACCESS_KEY_ID', S3_LOCAL_DEFAULTS.S3_ACCESS_KEY_ID),
    secretAccessKey: readValue(
      env,
      'S3_SECRET_ACCESS_KEY',
      S3_LOCAL_DEFAULTS.S3_SECRET_ACCESS_KEY,
    ),
  };
}

/** HTTP method the signed URL authorizes. */
export type PresignMethod = 'GET' | 'PUT';

/** Input for {@link presignUrl}. */
export interface PresignInput {
  readonly method: PresignMethod;
  readonly config: S3Config;
  /** Canonical object key (`tenant/{id}/{module}/{yyyy}/{mm}/{uuid}`). */
  readonly key: string;
  /** Lifetime in seconds; must be `1..300` (bases §4.5). */
  readonly expiresIn: number;
  /** Signing instant; defaults to the real clock. */
  readonly now?: Date;
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, payload: string): Buffer {
  return createHmac('sha256', key).update(payload, 'utf8').digest();
}

/** `YYYYMMDD'T'HHMMSS'Z'` stamp SigV4 requires. */
function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Builds a SigV4 pre-signed URL for one object. Throws a `RangeError` when
 * `expiresIn` leaves `1..300` and a `TypeError` on an empty key or an
 * unparseable endpoint — fail closed, never hand out an over-lived URL.
 */
export function presignUrl(input: PresignInput): string {
  const { method, config, key } = input;
  if (typeof key !== 'string' || key === '') {
    throw new TypeError('key must be a non-empty object key');
  }
  if (
    !Number.isInteger(input.expiresIn) ||
    input.expiresIn < 1 ||
    input.expiresIn > SIGNED_URL_TTL_SECONDS
  ) {
    throw new RangeError(
      `expiresIn must be an integer in 1..${SIGNED_URL_TTL_SECONDS} (got ${String(input.expiresIn)})`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new TypeError(`S3 endpoint is not a valid URL: ${config.endpoint}`);
  }

  const now = input.now ?? new Date();
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const credentialScope = `${date}/${config.region}/s3/aws4_request`;
  const credential = `${config.accessKeyId}/${credentialScope}`;
  const signedHeaders = 'host';

  const canonicalPath = `/${config.bucket}/${encodeKey(key)}`;
  const query: Array<readonly [string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresIn)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  // A presigned PUT with an unsigned streaming body: the client sends the
  // bytes with any content type, the signature covers only the host.
  if (method === 'PUT') query.push(['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD']);

  const canonicalQuery = query
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    `host:${endpoint.host}`,
    '',
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${config.secretAccessKey}`, date), config.region),
      's3',
    ),
    'aws4_request',
  );
  const signature = hmac(signingKey, toSign).toString('hex');

  return `${config.endpoint}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Pre-signed PUT URL for one canonical key (upload leg, `≤300s`). */
export function presignPutUrl(
  config: S3Config,
  key: string,
  expiresIn: number = SIGNED_URL_TTL_SECONDS,
  now?: Date,
): string {
  return presignUrl({ method: 'PUT', config, key, expiresIn, now });
}

/** Pre-signed GET URL for one canonical key (download leg, `≤300s`). */
export function presignGetUrl(
  config: S3Config,
  key: string,
  expiresIn: number = SIGNED_URL_TTL_SECONDS,
  now?: Date,
): string {
  return presignUrl({ method: 'GET', config, key, expiresIn, now });
}
