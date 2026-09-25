// Errors-CSV filename tests.
//
// The filename arrives in an upstream `Content-Disposition` header, so it is
// attacker-influenced data that ends up as a download target. These are the
// tests that pin the refusal: a path separator, a control character or a leading
// dot is never accepted, and the local fallback name is used instead — the
// download can therefore never write outside the browser's download directory or
// overwrite a hidden file.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { errorsCsvFilename, fallbackErrorsCsvFilename } from '../lib/salud-download.ts';

const JOB = '11111111-1111-4111-8111-111111111111';

test('sin cabecera: se usa el nombre local con el id del job', () => {
  assert.equal(fallbackErrorsCsvFilename(JOB), `import-${JOB}-errores.csv`);
  assert.equal(errorsCsvFilename(JOB), `import-${JOB}-errores.csv`);
  assert.equal(errorsCsvFilename(JOB, null), `import-${JOB}-errores.csv`);
  assert.equal(errorsCsvFilename(JOB, ''), `import-${JOB}-errores.csv`);
  assert.equal(errorsCsvFilename(JOB, 'attachment'), `import-${JOB}-errores.csv`);
});

test('filename simple: se respeta el nombre que declara el upstream', () => {
  assert.equal(
    errorsCsvFilename(JOB, 'attachment; filename="pacientes-errores.csv"'),
    'pacientes-errores.csv',
  );
  assert.equal(
    errorsCsvFilename(JOB, 'attachment; filename=pacientes-errores.csv'),
    'pacientes-errores.csv',
  );
});

test('RFC 5987: filename* gana sobre filename y se decodifica', () => {
  assert.equal(
    errorsCsvFilename(
      JOB,
      "attachment; filename=\"fallback.csv\"; filename*=UTF-8''errores%20pacientes.csv",
    ),
    'errores pacientes.csv',
  );
  assert.equal(
    errorsCsvFilename(JOB, "attachment; filename*=UTF-8''errores%20obras.csv"),
    'errores obras.csv',
  );
});

test('nombres inseguros: separador, carácter de control o punto inicial se rechazan', () => {
  const cases: readonly string[] = [
    'attachment; filename="../etc/passwd"',
    'attachment; filename="sub/dir.csv"',
    'attachment; filename="sub\\dir.csv"',
    'attachment; filename=".oculto.csv"',
    'attachment; filename="."',
    'attachment; filename=".."',
    'attachment; filename="con\u0000control.csv"',
    'attachment; filename="pipe|name.csv"',
    'attachment; filename="dos:puntos.csv"',
  ];
  for (const header of cases) {
    assert.equal(errorsCsvFilename(JOB, header), fallbackErrorsCsvFilename(JOB), header);
  }
});

test('filename* roto no bloquea el nombre simple ni el fallback', () => {
  // An invalid percent escape cannot be decoded, so the extended form is skipped.
  assert.equal(
    errorsCsvFilename(JOB, "attachment; filename=\"ok.csv\"; filename*=UTF-8''%E0%A4%A"),
    'ok.csv',
  );
  assert.equal(
    errorsCsvFilename(JOB, "attachment; filename*=UTF-8''%E0%A4%A"),
    fallbackErrorsCsvFilename(JOB),
  );
});
