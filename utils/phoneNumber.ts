/**
 * Normalizes a phone number string to E.164 format for Twilio.
 *
 * Rules (US-centric, handles most device contact formats):
 *   10 digits              → +1XXXXXXXXXX
 *   11 digits starting 1   → +1XXXXXXXXXX
 *   Already starts with +  → strip non-digits after +, reattach +
 *   Anything else          → returns null (caller should warn the user)
 */
export function toE164(raw: string): string | null {
  // Keep only digits
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // Already had a + prefix — trust the country code, just clean formatting
  if (raw.trimStart().startsWith('+') && digits.length >= 7) {
    return `+${digits}`;
  }

  return null;
}
