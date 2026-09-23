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
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { getServerUrl, fetchWithAuth } from './serverUrl';

const MY_PHONE_KEY = '@makeithome_my_phone';

export async function getMyPhone(): Promise<string | null> {
  try {
    return (await AsyncStorage.getItem(MY_PHONE_KEY)) || null;
  } catch {
    return null;
  }
}

// Store (or clear) the user's own number and sync the registration with the
// server. Returns a human-readable error, or null on success.
export async function setMyPhone(e164: string | null): Promise<string | null> {
  const old = await getMyPhone();
  try {
    if (!e164) {
      await AsyncStorage.removeItem(MY_PHONE_KEY);
      if (old) await serverRegister(old, ''); // back to SMS for this number
      return null;
    }
    await AsyncStorage.setItem(MY_PHONE_KEY, e164);
    if (old && old !== e164) await serverRegister(old, ''); // un-register the previous number
    return await registerPushForAlerts();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

// Ask for notification permission (if needed), fetch this device's push token,
// and tell the server "alerts for my number come here". Called after the user
// saves their number, and on every app launch to keep the server's TTL fresh.
// Returns a human-readable error, or null on success/no-op.
export async function registerPushForAlerts(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  const phone = await getMyPhone();
  if (!phone) return null; // feature not configured — nothing to do
  try {
    let perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) perms = await Notifications.requestPermissionsAsync();
    if (!perms.granted) return 'Notifications are off for Make It Home. Enable them in Settings to get circle alerts here.';
    const projectId =
      (Constants as any)?.expoConfig?.extra?.eas?.projectId ??
      (Constants as any)?.easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    if (!token?.data) return 'Could not get a push token for this device.';
    return await serverRegister(phone, token.data);
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

async function serverRegister(phone: string, token: string): Promise<string | null> {
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
    return null;
  } catch {
    return 'Could not reach the server — will retry on next launch.';
  }
}
