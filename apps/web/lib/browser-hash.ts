// Browser SHA-256 of a text payload — the replay key every CSV importer derives
// for itself.
//
// Why the *bytes* and not a random uuid: the API services key an import on
// `sha256(csv)` (§5.4, «toda importación es idempotente por hash del archivo»),
// so a re-upload of the same file — from a fresh page, another browser, or after
// a failed response — has to collapse into the original job. A per-click key
// would import the same bytes twice. The client therefore sends the same digest
// as its `Idempotency-Key` header.
//
// The module is separate from any one client because two verticals use it now
// (salud patients, obras workers/assets) and the ordinariness of the function is
// the point: one implementation, one failure message.
//
// The failure is part of the contract: `crypto.subtle` only exists in a secure
// context, and failing with this sentence beats sending a CSV with a random key
// and importing it twice.

/** Hex SHA-256 of a text payload, UTF-8 encoded. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      'El navegador no expone crypto.subtle (contexto no seguro). La importación requiere HTTPS o localhost.',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
