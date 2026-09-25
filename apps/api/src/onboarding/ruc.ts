// SUNAT RUC check digit (peru-anexo-v1.md §11 — validaciones: "RUC con dígito
// verificador"). A RUC is 11 digits: the first 10 are the base and the 11th is
// the check digit, computed with the fixed weights 5-4-3-2-7-6-5-4-3-2 modulo
// 11 (remainder 10 -> 0, remainder 11 -> 1). No dependencies.
const FACTORS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const BASE_LENGTH = 10;
const RUC_LENGTH = 11;

/**
 * Computes the SUNAT check digit for a 10-digit base.
 * Throws a TypeError when the base is not exactly 10 digits.
 */
export function computeCheckDigit(base10: string): string {
  if (typeof base10 !== 'string' || !/^\d{10}$/.test(base10)) {
    throw new TypeError('base10 must be exactly 10 digits');
  }
  let sum = 0;
  for (const [index, factor] of FACTORS.entries()) {
    sum += Number(base10.charAt(index)) * factor;
  }
  const check = 11 - (sum % 11);
  if (check === 10) return '0';
  if (check === 11) return '1';
  return String(check);
}

/**
 * Validates an 11-digit RUC against its own check digit.
 * Format only: this deliberately does not assert anything about RUC prefixes
 * or about the existence of the issuing taxpayer.
 */
export function validateRUC(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{11}$/.test(s)) return false;
  return computeCheckDigit(s.slice(0, BASE_LENGTH)) === s.charAt(BASE_LENGTH);
}

export const RUC_DIGITS = RUC_LENGTH;
