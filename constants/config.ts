// ─── Server configuration ────────────────────────────────────────────────────
// Values are read from environment variables (see .env / .env.example). Expo
// inlines EXPO_PUBLIC_* variables into the app at build time.
//
// SECURITY NOTE: EXPO_PUBLIC_* values are embedded in the built binary, so they
// are not truly secret from someone who inspects the app. REGISTRATION_SECRET
// only authorizes the one-time /register call that issues a per-device token;
// the real protection is enforced server-side. Keeping it in .env (gitignored)
// keeps it out of source control — rotate it on the server if it's ever exposed.

// The deployed server URL. HTTPS in production — emergency location data travels
// over it. Falls back to the production URL so the app runs without a .env.
export const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? 'https://makeithome-server-production.up.railway.app';

// Must match REGISTRATION_SECRET in your server environment. No source fallback —
// set it in .env (copy from .env.example).
export const REGISTRATION_SECRET = process.env.EXPO_PUBLIC_REGISTRATION_SECRET ?? '';

if (__DEV__ && !REGISTRATION_SECRET) {
  console.warn(
    '[MakeItHome] EXPO_PUBLIC_REGISTRATION_SECRET is not set. Copy .env.example to .env and ' +
    'fill it in (then restart the dev server), or device registration will fail.',
  );
}

if (__DEV__ && SERVER_URL.includes('localhost')) {
  console.warn(
    '[MakeItHome] SERVER_URL is set to localhost. ' +
    'Panic button and check-in features will not work on a physical device or in production.',
  );
}
