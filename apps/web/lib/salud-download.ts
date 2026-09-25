// Download helpers for the CSV exports of the Salud screens.
//
// Two jobs, one file, because they are the same concern seen twice: turning an
// upstream `Content-Disposition` into a safe filename, and handing the bytes to
// the browser. Both are kept out of the API client so the client stays about
// HTTP and contracts.
//
// `errorsCsvFilename` is deliberately strict about what it accepts. A filename
// is attacker-influenced data (the header arrives from upstream), so a path
// separator, a control character or a leading dot is refused and the local
// fallback name is used instead: the download can never write outside the
// browser's download directory or overwrite a hidden file.

/** Local fallback name of an import's errors CSV. */
export function fallbackErrorsCsvFilename(jobId: string): string {
  return `import-${jobId}-errores.csv`;
}

/** Characters a downloaded filename may not carry. */
const UNSAFE_FILENAME_RE = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * Filename of the errors CSV: the upstream `Content-Disposition` when it names
 * one and the name is safe, the local fallback otherwise.
 *
 * Both header forms are read: `filename*=UTF-8''<pct-encoded>` (RFC 5987) wins
 * over the plain `filename="..."`, which is what a server that ships non-ASCII
 * names sends.
 */
export function errorsCsvFilename(jobId: string, contentDisposition?: string | null): string {
  const header = contentDisposition ?? '';
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    const decoded = safeDecode(extended[1].trim().replace(/^"|"$/g, ''));
    if (isSafeFilename(decoded)) return decoded;
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  if (plain?.[1] !== undefined) {
    const candidate = plain[1].trim();
    if (isSafeFilename(candidate)) return candidate;
  }
  return fallbackErrorsCsvFilename(jobId);
}

function isSafeFilename(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false;
  if (value.startsWith('.')) return false;
  return !UNSAFE_FILENAME_RE.test(value);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/**
 * Hands a text payload to the browser as a file. Uses an object URL and revokes
 * it immediately after the click, so the CSV never becomes a live URL a script
 * could reuse. Nothing is written to the repository or the server: the bytes
 * came from the API and go to the user's download directory.
 */
export function saveTextFile(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
