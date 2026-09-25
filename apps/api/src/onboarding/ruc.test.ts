// RUC verifier (peru-anexo-v1.md §11 — validaciones: RUC con dígito verificador).
// Runs with node:test, no dependencies.
// All bases here are synthetic demo data; no assertion claims anything about a
// real, externally issued RUC.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCheckDigit, validateRUC } from './ruc.ts';

const FACTORS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Deterministic synthetic 10-digit base (LCG) — never a real RUC. */
function demoBase(seed: number): string {
  let x = (seed + 1) >>> 0;
  let out = '';
  for (let i = 0; i < 10; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += String((x >>> 8) % 10);
  }
  return out;
}

function weightedSum(base: string): number {
  return base
    .split('')
    .reduce((acc, digit, i) => acc + Number(digit) * (FACTORS[i] as number), 0);
}

describe('validateRUC', () => {
  it('rejects values that are not a plain 11-digit string', () => {
    assert.equal(validateRUC(undefined as unknown as string), false);
    assert.equal(validateRUC(null as unknown as string), false);
    assert.equal(validateRUC(''), false);
    assert.equal(validateRUC('2012345678A'), false);
    assert.equal(validateRUC('20-1234567-86'), false);
    assert.equal(validateRUC('2 0123456786'), false);
  });

  it('rejects 10-digit and 12-digit values', () => {
    assert.equal(validateRUC('2012345678'), false);
    assert.equal(validateRUC('201234567890'), false);
    assert.equal(validateRUC('2012345678'.padStart(11, '0').slice(0, 10)), false);
  });

  it('rejects an 11-digit value whose check digit is wrong', () => {
    const base = demoBase(7);
    const good = computeCheckDigit(base);
    const wrong = String((Number(good) + 1) % 10);
    assert.notEqual(good, wrong);
    assert.equal(validateRUC(base + wrong), false);
  });

  it('accepts the value produced by computeCheckDigit (round-trip)', () => {
    for (let seed = 0; seed < 200; seed++) {
      const base = demoBase(seed);
      const ruc = base + computeCheckDigit(base);
      assert.equal(ruc.length, 11);
      assert.equal(validateRUC(ruc), true, `round-trip failed for base ${base}`);
    }
  });
});

describe('computeCheckDigit', () => {
  it('returns a single decimal digit for a synthetic base', () => {
    const digit = computeCheckDigit(demoBase(3));
    assert.equal(digit.length, 1);
    assert.match(digit, /^[0-9]$/);
  });

  it('is deterministic for the same base', () => {
    const base = demoBase(11);
    assert.equal(computeCheckDigit(base), computeCheckDigit(base));
  });

  it('maps remainder 10 to digit 0 and remainder 11 to digit 1', () => {
    let sawRemainder1 = false;
    let sawRemainder0 = false;
    for (let n = 0; n < 90 && !(sawRemainder1 && sawRemainder0); n++) {
      const base = `20000000${String(10 + n).padStart(2, '0')}`;
      const remainder = weightedSum(base) % 11;
      if (remainder === 1) {
        assert.equal(computeCheckDigit(base), '0');
        sawRemainder1 = true;
      }
      if (remainder === 0) {
        assert.equal(computeCheckDigit(base), '1');
        sawRemainder0 = true;
      }
    }
    assert.equal(sawRemainder1, true, 'no base with sum % 11 === 1 was found');
    assert.equal(sawRemainder0, true, 'no base with sum % 11 === 0 was found');
  });

  it('rejects a base that is not exactly 10 digits', () => {
    assert.throws(() => computeCheckDigit('201234567'));
    assert.throws(() => computeCheckDigit('201234567890'));
    assert.throws(() => computeCheckDigit('20123A5678'));
    assert.throws(() => computeCheckDigit(''));
  });
});
