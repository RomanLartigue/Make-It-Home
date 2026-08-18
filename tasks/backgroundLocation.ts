// Background location task for live sessions.
//
// While a go-live session is active, iOS keeps delivering location fixes to this
// task even when the phone is locked or the app is switched away (requires the
// 'location' UIBackgroundMode + "Always" permission). Each fix is pushed to the
// server so the safety circle's live link keeps updating.
//
// TaskManager.defineTask MUST run at module top level, and this module MUST be
// imported at app launch (it is, from app/_layout.tsx) — otherwise iOS wakes the
// app for a fix and there's no task registered to receive it.

import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getServerUrl, fetchWithAuth } from '@/utils/serverUrl';

export const BACKGROUND_LOCATION_TASK = 'makeithome-background-location';
const ACTIVE_SESSION_KEY = '@makeithome_active_session';

// Throttle server pushes: iOS can deliver several fixes per second in the
// background; the live page only needs one every ~15s.
let lastPushAt = 0;
const MIN_PUSH_INTERVAL_MS = 15_000;

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
  if (!locations || locations.length === 0) return;

  const now = Date.now();
  if (now - lastPushAt < MIN_PUSH_INTERVAL_MS) return;

  // Only push while a session is actually live. The active session id is
  // persisted so this works even if the JS app was suspended and resumed.
  const sessionId = await AsyncStorage.getItem(ACTIVE_SESSION_KEY).catch(() => null);
  if (!sessionId) return;

  const latest = locations[locations.length - 1];
  lastPushAt = now;
  try {
    const serverUrl = await getServerUrl();
    await fetchWithAuth(`${serverUrl}/session/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        latitude: latest.coords.latitude,
        longitude: latest.coords.longitude,
      }),
    });
  } catch {
    // best-effort; the next fix will retry
  }
});

/** Start background location updates for the live session (idempotent). */
export async function startBackgroundLocation(): Promise<boolean> {
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false);
    if (already) return true;
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 10_000,
      distanceInterval: 15,
      // Keeps iOS delivering fixes while backgrounded/locked; the blue status
      // bar indicator is required by Apple and reassures the user it's working.
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: 'Make It Home is live',
        notificationBody: 'Sharing your live location with your safety circle.',
        notificationColor: '#ff6a4d',
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Stop background location updates (idempotent). */
export async function stopBackgroundLocation(): Promise<void> {
  try {
    const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  } catch {
    // ignore
  }
}
