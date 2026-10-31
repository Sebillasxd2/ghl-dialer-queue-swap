const TOLL_FREE_AREA_CODES = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * Normalizes a North American number to E.164 (`+1XXXXXXXXXX`), or returns null.
 * A number GHL cannot parse can be dropped from the contact without an error, and the
 * lead then never reaches the dialer. Rejecting it here keeps the failure visible.
 */
export function toE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  // NANP: neither the area code nor the exchange may start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}

/** Toll-free lines are switchboards and call centers, never the person we want. */
export function isTollFree(e164: string): boolean {
  return TOLL_FREE_AREA_CODES.has(e164.slice(2, 5));
}
