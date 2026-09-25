// Object-key builder for tenant-scoped files (bases-consolidadas-v1.md §4.5).
//
// Canonical key shape: `tenant/{tenant_id}/{module}/{yyyy}/{mm}/{uuid}`.
// Pure by design: no storage client, no clock, no I/O. The API uses it to
// compute bucket keys and the parse side to authorize signed downloads; the
// signed URL life is capped at 5 minutes and no permanent public URL is ever
// handed out for health data.
//
// Validation rules:
// - tenant id must be a UUID (any version),
// - module must belong to the closed module list from bases §2.1,
// - object id must be a UUID v4,
// - date must carry a valid four-digit year and a month in 1..12.

/** Closed set of module codes (bases-consolidadas-v1.md §2.1). */
export const FILE_MODULES = [
  'crm-core',
  'salud',
  'obras',
  'inventario',
  'asistencia',
  'facturacion',
  'reportes',
  'builder',
  'notify',
  'campo',
] as const;

export type FileModule = (typeof FILE_MODULES)[number];

/** Module whose files must never be reachable through a permanent public URL. */
export const HEALTH_MODULE: FileModule = 'salud';

/** Signed URL lifetime in seconds (≤5 min, bases §4.5). */
export const SIGNED_URL_TTL_SECONDS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-\d{2}(?:[T ].*)?$/;

function isUuid(value: string): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isUuidV4(value: string): boolean {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

function isFileModule(value: string): value is FileModule {
  return (FILE_MODULES as readonly string[]).includes(value);
}

/** Parses the leading `YYYY-MM` of an ISO date and validates the month. */
function parseYearMonth(dateISO: string): { year: number; month: number } {
  if (typeof dateISO !== 'string') {
    throw new TypeError('dateISO must be a string');
  }
  const match = DATE_RE.exec(dateISO);
  if (!match) {
    throw new TypeError('dateISO must be an ISO date (YYYY-MM-DD)');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new RangeError(`dateISO month out of range: ${month}`);
  }
  return { year, month };
}

/**
 * Builds the canonical storage key for a tenant-scoped file.
 *
 * @throws TypeError when the tenant is not a UUID, the module is outside the
 * closed list, the object id is not UUID v4, or the date is malformed.
 */
export function buildObjectKey(
  tenantId: string,
  module: string,
  dateISO: string,
  uuid: string,
): string {
  if (!isUuid(tenantId)) {
    throw new TypeError('tenantId must be a UUID');
  }
  if (!isFileModule(module)) {
    throw new TypeError(`module must be one of ${FILE_MODULES.join(', ')}`);
  }
  if (!isUuidV4(uuid)) {
    throw new TypeError('uuid must be a UUID v4');
  }
  const { year, month } = parseYearMonth(dateISO);
  const mm = String(month).padStart(2, '0');
  return `tenant/${tenantId.toLowerCase()}/${module}/${year}/${mm}/${uuid.toLowerCase()}`;
}

export interface ParsedObjectKey {
  tenantId: string;
  module: FileModule;
  year: number;
  month: number;
  uuid: string;
}

const KEY_RE =
  /^tenant\/([0-9a-f-]{36})\/([a-z0-9-]+)\/(\d{4})\/(\d{2})\/([0-9a-f-]{36})$/i;

/**
 * Inverse of {@link buildObjectKey}: returns the parsed parts or `null` when
 * the key does not match the canonical shape and validations.
 */
export function parseObjectKey(key: string): ParsedObjectKey | null {
  if (typeof key !== 'string') return null;
  const match = KEY_RE.exec(key);
  if (!match) return null;
  const [, tenantId, module, yearText, monthText, uuid] = match;
  const month = Number(monthText);
  if (!isUuid(tenantId) || !isFileModule(module) || !isUuidV4(uuid)) return null;
  if (month < 1 || month > 12) return null;
  return {
    tenantId: tenantId.toLowerCase(),
    module,
    year: Number(yearText),
    month,
    uuid: uuid.toLowerCase(),
  };
}

/** True when the module holds health data (no permanent public URL). */
export function isHealthModule(module: string): boolean {
  return module === HEALTH_MODULE;
}
