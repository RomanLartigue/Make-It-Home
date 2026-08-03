import AsyncStorage from '@react-native-async-storage/async-storage';
import { SERVER_URL, REGISTRATION_SECRET } from '@/constants/config';

const NAME_KEY = '@makeithome_user_name';
const DEVICE_ID_KEY = '@makeithome_device_id';
const DEVICE_TOKEN_KEY = '@makeithome_device_token';

// Server URL is hardcoded — users never configure this.
export async function getServerUrl(): Promise<string> {
  return SERVER_URL;
}

export async function getUserName(): Promise<string> {
  const saved = await AsyncStorage.getItem(NAME_KEY);
  return saved?.trim() || '';
}

export async function setUserName(name: string): Promise<void> {
  await AsyncStorage.setItem(NAME_KEY, name.trim());
}

// ── Device identity ───────────────────────────────��───────────────────────────
// A random 128-bit hex ID generated once per installation and persisted.
// Resets if the user clears app data or reinstalls — a fresh token is issued.
// Generates `byteLength` random bytes as hex. Uses Web Crypto when the runtime
// provides it, and falls back to Math.random() otherwise — some React Native /
// Hermes builds don't expose a global `crypto`, and a missing polyfill must not
// break device registration on first launch.
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const g = globalThis as any;
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getOrCreateDeviceId(): Promise<string> {
  const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (stored) return stored;
  const id = randomHex(16);
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

async function registerDevice(): Promise<string | null> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const res = await fetch(`${SERVER_URL}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MIH-Registration-Secret': REGISTRATION_SECRET,
      },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) return null;
    const { token } = await res.json() as { token: string };
    await AsyncStorage.setItem(DEVICE_TOKEN_KEY, token);
    return token;
  } catch {
    return null;
  }
}

// In-flight deduplication: if multiple callers ask for a token at the same
// moment (e.g. on first launch), they all wait for the single registration
// request rather than hammering the server.
let registrationInFlight: Promise<string | null> | null = null;

export async function getDeviceToken(): Promise<string | null> {
  const stored = await AsyncStorage.getItem(DEVICE_TOKEN_KEY);
  if (stored) return stored;

  if (!registrationInFlight) {
    registrationInFlight = registerDevice().finally(() => {
      registrationInFlight = null;
    });
  }
  return registrationInFlight;
}

// ── Authenticated fetch ──────────────────────────���────────────────────────────
// Attaches the per-device token on every outbound request.
// On 401 (token unknown to server, e.g. after a server restart without Redis),
// clears the stored token, re-registers, and retries the request once.
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getDeviceToken();
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers['X-MIH-Key'] = token;

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    await AsyncStorage.removeItem(DEVICE_TOKEN_KEY);
    const newToken = await getDeviceToken();
    const retryHeaders = { ...headers };
    if (newToken) retryHeaders['X-MIH-Key'] = newToken;
    return fetch(url, { ...options, headers: retryHeaders });
  }

  return res;
}
