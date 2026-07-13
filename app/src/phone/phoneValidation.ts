import { COUNTRY_DIAL_CODES, type CountryDialCode } from "../constants/countryCodes";

// Precise rules for the countries we can validate with confidence; every
// other dial code falls back to a generic digit-count check rather than
// trying to model every country's numbering plan.
const COUNTRY_RULES: Record<string, { length: number; startsWith?: RegExp }> = {
  "91": { length: 10, startsWith: /^[6-9]/ }, // India mobile numbers
  "1": { length: 10 }, // NANP (US/Canada/etc.)
  "44": { length: 10, startsWith: /^7/ }, // UK mobile numbers
};

const GENERIC_MIN_DIGITS = 6;
const GENERIC_MAX_DIGITS = 14;

export function sanitizeDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function isValidLocalNumber(dialCode: string, localDigits: string): boolean {
  if (!localDigits) return false;
  const rule = COUNTRY_RULES[dialCode];
  if (rule) {
    if (localDigits.length !== rule.length) return false;
    if (rule.startsWith && !rule.startsWith.test(localDigits)) return false;
    return true;
  }
  return localDigits.length >= GENERIC_MIN_DIGITS && localDigits.length <= GENERIC_MAX_DIGITS;
}

export function toE164(dialCode: string, localDigits: string): string {
  return `+${dialCode}${localDigits}`;
}

/**
 * Splits a stored E.164 number back into {country, localDigits} to prefill
 * the edit UI. Dial codes aren't a fixed length (+1 vs +91 vs +212), so this
 * tries the longest known prefix first to avoid e.g. matching "+1" inside a
 * number that's really "+123...".
 */
export function parseE164(value: string): { country: CountryDialCode; localDigits: string } | null {
  if (!value.startsWith("+")) return null;
  const digits = value.slice(1);
  const byLength = [...COUNTRY_DIAL_CODES].sort((a, b) => b.dialCode.length - a.dialCode.length);
  for (const country of byLength) {
    if (digits.startsWith(country.dialCode)) {
      return { country, localDigits: digits.slice(country.dialCode.length) };
    }
  }
  return null;
}
