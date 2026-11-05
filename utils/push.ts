// Receiving circle alerts as push notifications instead of texts.
//
// A user who is IN someone's safety circle can register their own phone number
// here; the server then delivers any alert addressed to that number as a free
// push notification (SMS remains the automatic fallback, and circle members
// without the app keep getting plain texts). This is the cost side of the
// hybrid delivery model: every registered member converts ~1c texts into $0
// pushes.
//
// Everything is best-effort: push is an upgrade, never a requirement, so no
// failure here may ever break anything else.
import { Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { getServerUrl, fetchWithAuth } from './serverUrl';

const MY_PHONE_KEY = '@makeithome_my_phone';
// Set once /push/verify succeeds. Launch-time registration only runs for
// verified numbers: re-registering an unverified one made the server text a
// fresh code + pop a prompt on EVERY cold start until the user verified.
const VERIFIED_KEY = '@makeithome_phone_verified';

export async function getMyPhone(): Promise<string | null> {
  try {
    return (await AsyncStorage.getItem(MY_PHONE_KEY)) || null;
  } catch {
    return null;
  }
}

async function isVerified(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(VERIFIED_KEY)) === '1';
  } catch {
    return false;
  }
}
async function setVerified(on: boolean): Promise<void> {
  try {
    if (on) await AsyncStorage.setItem(VERIFIED_KEY, '1');
    else await AsyncStorage.removeItem(VERIFIED_KEY);
  } catch {}
}

// Store (or clear) the user's own number and sync the registration with the
// server. Returns a human-readable error, or null on success.
export async function setMyPhone(e164: string | null): Promise<string | null> {
  const old = await getMyPhone();
  try {
    if (!e164) {
      await AsyncStorage.removeItem(MY_PHONE_KEY);
      await setVerified(false);
      if (old) {
        // Propagate the result: "cleared" must not read as done when the
        // server never heard about it (pushes would keep arriving here).
        const err = await serverRegister(old, '', { allowPrompt: false });
        if (err) return `Cleared on this phone — ${err}`;
      }
      return null;
    }
    await AsyncStorage.setItem(MY_PHONE_KEY, e164);
    if (old && old !== e164) {
      await setVerified(false);
      await serverRegister(old, '', { allowPrompt: false }); // un-register the previous number
    }
    return await registerPushForAlerts({ userInitiated: true });
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

// Ask for notification permission (if needed), fetch this device's push token,
// and tell the server "alerts for my number come here". Called after the user
// saves their number (userInitiated: may prompt for the texted code), and on
// every app launch to keep the server's TTL fresh (silent: verified numbers
// refresh quietly; unverified ones are left alone until the user re-saves).
// Returns a human-readable error, or null on success/no-op.
export async function registerPushForAlerts(
  opts: { userInitiated?: boolean } = {},
): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  const phone = await getMyPhone();
  if (!phone) return null; // feature not configured — nothing to do
  if (!opts.userInitiated && !(await isVerified())) return null; // see VERIFIED_KEY
  try {
    let perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) perms = await Notifications.requestPermissionsAsync();
    if (!perms.granted) return 'Notifications are off for Make It Home. Enable them in Settings to get circle alerts here.';
    const projectId =
      (Constants as any)?.expoConfig?.extra?.eas?.projectId ??
      (Constants as any)?.easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    if (!token?.data) return 'Could not get a push token for this device.';
    return await serverRegister(phone, token.data, { allowPrompt: !!opts.userInitiated });
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

async function serverRegister(
  phone: string,
  token: string,
  opts: { allowPrompt: boolean },
): Promise<string | null> {
  try {
    const serverUrl = await getServerUrl();
    const res = await fetchWithAuth(`${serverUrl}/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, token }),
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error;
      return msg || `Registration failed (HTTP ${res.status}).`;
    }
    const j = await res.json().catch(() => null);
    // First-time binding: the server texts a 6-digit code to the number to
    // prove this phone actually owns it (without proof, anyone could divert
    // someone else's safety alerts to their own device). A device that has
    // already verified this number gets {ok} with no pending — silent refresh.
    if (j?.pending) {
      await setVerified(false);
      if (opts.allowPrompt) promptForCode(phone);
      return null;
    }
    if (token) await setVerified(true); // non-pending ok on a real registration = trusted
    return null;
  } catch {
    return 'Could not reach the server — will retry on next launch.';
  }
}

// Ask for the texted code (up to 3 tries). Alert.prompt is iOS-native; this
// app ships iOS-first. Entirely best-effort: dismissing just means alerts for
// this number stay texts until the next registration attempt.
function promptForCode(phone: string, attempt = 1) {
  if (Platform.OS !== 'ios') return;
  Alert.prompt(
    'Verify your number',
    `We texted a 6-digit code to ${phone}. Enter it so circle alerts reach you here as notifications. (You can also do this later by re-saving your number in Settings.)`,
    [
      { text: 'Not now', style: 'cancel' },
      {
        text: 'Verify',
        onPress: async (value?: string) => {
          const code = String(value ?? '').trim();
          try {
            const serverUrl = await getServerUrl();
            const res = await fetchWithAuth(`${serverUrl}/push/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone, code }),
            });
            if (res.ok) {
              await setVerified(true);
              Alert.alert('You’re set', 'Circle alerts will now reach you as notifications.');
              return;
            }
            const msg = (await res.json().catch(() => null))?.error || 'Wrong code.';
            if (attempt < 3) promptForCode(phone, attempt + 1);
            else Alert.alert('Verification failed', `${msg} Save your number again to retry.`);
          } catch {
            Alert.alert('Could not verify', 'Check your connection and try again.');
          }
        },
      },
    ],
    'plain-text',
    '',
    'number-pad',
  );
}
