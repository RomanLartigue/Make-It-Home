/**
 * Normalizes a phone number string to E.164 format for Twilio.
 *
 * Rules (US-centric, handles most device contact formats):
 *   10 digits (valid NANP)    → +1XXXXXXXXXX
 *   11 digits starting 1      → +1XXXXXXXXXX (same NANP check)
 *   Starts with + or 00       → cleaned international number, validated
 *   Anything else             → null (caller should warn the user)
 *
 * Validation matters here more than convenience: a silently-mis-normalized
 * number means safety alerts go to a stranger (or nowhere) while the user
 * believes that person is protected. The server rejects anything that fails
 * /^\+[1-9]\d{6,14}$/, so everything returned from here must pass that.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  // Keep only digits
  let digits = trimmed.replace(/\D/g, '');

  // "00" international dialing prefix → same as "+"
  const intl = trimmed.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (intl) {
    // Strip a parenthesized trunk zero pasted from contacts ("+44 (0) 20 …"):
    // it belongs to domestic dialing and makes the number undeliverable.
    const deTrunked = trimmed.replace(/^(\+?\d{1,3})\s*\(0\)/, '$1');
    digits = deTrunked.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    // E.164: no leading 0, 8–15 digits total (7-digit "numbers" are truncated
    // pastes, not reachable destinations).
    if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
    // A +1 number is NANP — hold it to the same shape as the bare-US path.
    if (digits.startsWith('1')) {
      return digits.length === 11 && isNanp(digits.slice(1)) ? `+${digits}` : null;
    }
    return `+${digits}`;
  }

  if (digits.length === 10) {
    // Bare 10 digits are assumed US — but only when they're a POSSIBLE US
    // number. (A Mexican or Australian local number pasted from contacts is 10
    // digits too; "+1" would silently point the alert at a stranger.)
    return isNanp(digits) ? `+1${digits}` : null;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return isNanp(digits.slice(1)) ? `+${digits}` : null;
  }

  return null;
}

// NANP (US/Canada) shape: area code and exchange each start 2-9.
function isNanp(tenDigits: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits);
}
