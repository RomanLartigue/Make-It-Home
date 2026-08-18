import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Alert,
  Easing,
  Platform,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { useRouter, useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { CameraView, Camera } from 'expo-camera';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getServerUrl, getUserName, fetchWithAuth, randomId, syncCircle } from '@/utils/serverUrl';
import { Beacon } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';
import { ESCALATION_SCHEDULE_KEY, DEFAULT_SCHEDULE, normalizeSchedule } from '@/constants/escalation';
import { startBackgroundLocation, stopBackgroundLocation } from '@/tasks/backgroundLocation';
import { isGold } from '@/utils/gold';
import { startBackgroundAudio, stopBackgroundAudio } from '@/utils/backgroundAudio';

// Shown when a permission isn't granted. If it was previously blocked, the OS
// won't show its own dialog again (canAskAgain === false) — so offer a route to
// the system Settings, which is the only place the user can flip it back on.
function permissionDeniedAlert(title: string, message: string) {
  Alert.alert(title, message, [
    { text: 'Not now', style: 'cancel' },
    { text: 'Open Settings', onPress: () => Linking.openSettings() },
  ]);
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const SAFETY_CIRCLE_KEY = '@makeithome_safety_circle';
const CHECKIN_KEY = '@makeithome_checkin';
const CHECKIN_NOTIF_KEY = '@makeithome_checkin_notif';
const ACTIVE_SESSION_KEY = '@makeithome_active_session';

// Beacon swipe directions -> check-in duration. Matches the prototype's
// 15 / 30 / 45 / 60-minute radial options.
const DIR: Record<string, { sec: number; label: string }> = {
  left: { sec: 15 * 60, label: '15' },
  up: { sec: 30 * 60, label: '30' },
  right: { sec: 45 * 60, label: '45' },
  down: { sec: 60 * 60, label: '60' },
};

// On web/desktop the hold-and-swipe gesture is awkward (or impossible) with a
// mouse, so there we make the beacon and the timer chips plain click targets.
// Touch devices keep the hold-and-swipe gesture.
const IS_WEB = Platform.OS === 'web';

// ── Server / notification helpers (unchanged backend contract) ───────────────
async function checkServerHealth(serverUrl: string) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetchWithAuth(`${serverUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function scheduleCheckInWarning(expiresAt: number) {
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return null;
  const triggerSeconds = Math.round((expiresAt - Date.now()) / 1000) - 120;
  if (triggerSeconds <= 0) return null;
  return Notifications.scheduleNotificationAsync({
    content: {
      title: '⏰ Check-in due in 2 minutes',
      body: "Tap to confirm you're safe before your circle gets an alert.",
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: triggerSeconds,
    },
  });
}

async function cancelCheckInWarning(notifId: string | null) {
  if (notifId) await Notifications.cancelScheduledNotificationAsync(notifId).catch(() => {});
}

async function getSafetyCirclePhones(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(SAFETY_CIRCLE_KEY);
  const circle = raw ? JSON.parse(raw) : [];
  return circle.map((c: any) => c.phone).filter(Boolean);
}

// Build the escalation rounds for a go-live: the whole circle is alerted now
// (round 0), then re-texted after each scheduled wait until someone acknowledges.
// Every round targets the SAME whole circle. Returns null when the circle is empty.
async function getEscalationTiers(): Promise<
  { name: string; waitMinutes: number; phones: string[] }[] | null
> {
  const [rawCircle, rawSchedule] = await Promise.all([
    AsyncStorage.getItem(SAFETY_CIRCLE_KEY),
    AsyncStorage.getItem(ESCALATION_SCHEDULE_KEY),
  ]);
  const circle: any[] = rawCircle ? JSON.parse(rawCircle) : [];
  const phones = circle.map(c => c.phone).filter(Boolean);
  if (!phones.length) return null;
  // Custom timing is a Gold feature: free users always run the fixed default
  // schedule, even if a custom one is on disk (e.g. Gold lapsed).
  const gold = await isGold();
  const schedule = gold
    ? normalizeSchedule(rawSchedule ? JSON.parse(rawSchedule) : DEFAULT_SCHEDULE)
    : DEFAULT_SCHEDULE;
  const rounds = [{ name: 'Alert', waitMinutes: 0, phones }];
  schedule.forEach((wait, i) => {
    rounds.push({ name: `Reminder ${i + 1}`, waitMinutes: wait, phones });
  });
  return rounds;
}

function formatTime(secs: number) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function HomeScreen() {
  const router = useRouter();

  // Home / cover state
  const [circleCount, setCircleCount] = useState(0);
  const [locGranted, setLocGranted] = useState(false);

  // Session (go-live) state
  const [showCamera, setShowCamera] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [coords, setCoords] = useState<Location.LocationObjectCoords | null>(null);
  const [notifyStatus, setNotifyStatus] = useState<
    'idle' | 'notified' | 'saved' | 'uploading' | 'uploaded' | 'error'
  >('idle');

  const cameraRef = useRef<CameraView>(null);
  const locationSub = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const lastLocationUpdateRef = useRef(0);
  const isRecordingRef = useRef(false);
  const goLiveFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAudioUriRef = useRef<string | null>(null); // background audio from the last session

  // Check-in state
  const [checkInActive, setCheckInActive] = useState(false);
  const [checkInRemaining, setCheckInRemaining] = useState(0);
  const [checkInStarting, setCheckInStarting] = useState(false);
  const checkInId = useRef<string | null>(null);
  const checkInExpiresAt = useRef<number | null>(null);
  const checkInIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkInNotifId = useRef<string | null>(null);

  // Beacon gesture state
  const [armed, setArmed] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [showCheckIn, setShowCheckIn] = useState(false);
  const selRef = useRef<string | null>(null);
  const recordDurationSecRef = useRef<number>(30 * 60); // chosen recording length
  const beaconXY = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current; // joystick offset
  const pulse = useRef(new Animated.Value(1)).current;
  const livePulse = useRef(new Animated.Value(1)).current;

  // ── Refresh circle count + location status whenever Home is focused ────────
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const raw = await AsyncStorage.getItem(SAFETY_CIRCLE_KEY);
        const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
        if (!active) return;
        setCircleCount(raw ? JSON.parse(raw).length : 0);
        setLocGranted(!!perm?.granted);
      })();
      return () => {
        active = false;
      };
    }, []),
  );

  // Idle beacon pulse
  useEffect(() => {
    if (armed || showCamera || checkInActive) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        // JS driver (not native): the beacon's transform also carries beaconXY
        // (the joystick offset), which must be JS-driven to follow the thumb.
        // Mixing drivers on one view throws "node moved to native".
        Animated.timing(pulse, {
          toValue: 1.06,
          duration: 1300,
          useNativeDriver: false,
          easing: Easing.inOut(Easing.ease),
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1300,
          useNativeDriver: false,
          easing: Easing.inOut(Easing.ease),
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [armed, showCamera, checkInActive, pulse]);

  // Live pulse for camera / check-in overlays
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 1.1, duration: 700, useNativeDriver: false }),
        Animated.timing(livePulse, { toValue: 1, duration: 700, useNativeDriver: false }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [livePulse]);

  // Recording elapsed timer
  useEffect(() => {
    if (isRecording) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(prev => prev + 1), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  // Restore a check-in that was mid-countdown when the app closed
  useEffect(() => {
    AsyncStorage.getItem(CHECKIN_KEY).then(async raw => {
      if (!raw) return;
      const { id, expiresAt } = JSON.parse(raw);
      const remaining = Math.round((expiresAt - Date.now()) / 1000);
      if (remaining <= 0) {
        AsyncStorage.multiRemove([CHECKIN_KEY, CHECKIN_NOTIF_KEY]);
        return;
      }
      checkInId.current = id;
      checkInExpiresAt.current = expiresAt;
      setCheckInRemaining(remaining);
      setCheckInActive(true);

      const oldNotifId = await AsyncStorage.getItem(CHECKIN_NOTIF_KEY);
      if (oldNotifId) await cancelCheckInWarning(oldNotifId);
      const newNotifId = await scheduleCheckInWarning(expiresAt);
      checkInNotifId.current = newNotifId;
      if (newNotifId) await AsyncStorage.setItem(CHECKIN_NOTIF_KEY, newNotifId);
      else await AsyncStorage.removeItem(CHECKIN_NOTIF_KEY);

      checkInIntervalRef.current = setInterval(() => {
        const r = Math.max(0, Math.round(((checkInExpiresAt.current || 0) - Date.now()) / 1000));
        setCheckInRemaining(r);
        if (r === 0) {
          if (checkInIntervalRef.current) clearInterval(checkInIntervalRef.current);
          setCheckInActive(false);
          AsyncStorage.multiRemove([CHECKIN_KEY, CHECKIN_NOTIF_KEY]);
          cancelCheckInWarning(checkInNotifId.current);
          checkInNotifId.current = null;
        }
      }, 1000);
    });
    return () => {
      if (checkInIntervalRef.current) clearInterval(checkInIntervalRef.current);
    };
  }, []);

  // ── Backend calls (identical behavior to the original SafetyScreen) ────────
  const startSession = async (loc: Location.LocationObjectCoords | null) => {
    const phones = await getSafetyCirclePhones();
    if (phones.length === 0) {
      Alert.alert('No safety circle', 'Add contacts to your Safety Circle so they can be notified.');
      return;
    }
    // Ensure the server has this circle under the CURRENT device token before we
    // send — syncCircle elsewhere is best-effort/async and the token may have
    // rotated (401 re-register), which would otherwise 400 as "no circle on file".
    await syncCircle(phones);
    const [serverUrl, name, tiers] = await Promise.all([
      getServerUrl(),
      getUserName(),
      getEscalationTiers(),
    ]);
    const sessionId = sessionIdRef.current;
    lastLocationUpdateRef.current = Date.now();
    try {
      const res = await fetchWithAuth(`${serverUrl}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          phones,
          // Staged escalation: first tier is alerted now, later tiers climb if
          // no one responds. Null → server alerts the whole circle at once.
          tiers,
          name,
          // May be null when we alert before a GPS fix — the live page shows
          // "Location pending…" and updates as fixes arrive.
          latitude: loc?.latitude ?? null,
          longitude: loc?.longitude ?? null,
        }),
      });
      setNotifyStatus(res.ok ? 'notified' : 'error');
    } catch {
      setNotifyStatus('error');
    }
  };

  const updateLocation = (loc: Location.LocationObjectCoords) => {
    if (!sessionIdRef.current) return;
    getServerUrl().then(serverUrl => {
      fetchWithAuth(`${serverUrl}/session/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          latitude: loc.latitude,
          longitude: loc.longitude,
        }),
      }).catch(() => {});
    });
  };

  const uploadRecording = async (videoUri: string, sessionId?: string | null) => {
    const phones = await getSafetyCirclePhones();
    if (phones.length === 0) return;
    await syncCircle(phones); // guarantee the server has this circle under the current token
    setNotifyStatus('uploading');
    const serverUrl = await getServerUrl();
    const formData = new FormData();
    formData.append('video', { uri: videoUri, type: 'video/mp4', name: 'recording.mp4' } as any);
    formData.append('phones', JSON.stringify(phones));
    // Tie the recording to its session so the responder's live page can offer a
    // "Download recording" link once it lands.
    if (sessionId) formData.append('sessionId', sessionId);
    // Gold: keep this recording in cloud history (90 days) with a bit of context.
    const gold = await isGold();
    if (gold) {
      if (coords) {
        formData.append('latitude', String(coords.latitude));
        formData.append('longitude', String(coords.longitude));
      }
      formData.append('durationSec', String(recordDurationSecRef.current));
    }
    try {
      const res = await fetchWithAuth(`${serverUrl}/upload${gold ? '?gold=1' : ''}`, { method: 'POST', body: formData });
      if (res.ok) setNotifyStatus('uploaded');
      else {
        console.error('Upload error:', await res.json().catch(() => ({})));
        setNotifyStatus('error');
      }
    } catch (err) {
      console.error('Upload fetch failed:', err);
      setNotifyStatus('error');
    }
  };

  // ── Check-in timer ─────────────────────────────────────────────────────────
  const startCheckIn = async (durationSeconds: number) => {
    const phones = await getSafetyCirclePhones();
    if (phones.length === 0) {
      Alert.alert('No safety circle', 'Add contacts to your Safety Circle first.');
      return;
    }
    await syncCircle(phones); // guarantee the server has this circle under the current token
    setCheckInStarting(true);
    const serverUrl = await getServerUrl();
    const serverOk = await checkServerHealth(serverUrl);
    if (!serverOk) {
      setCheckInStarting(false);
      Alert.alert(
        'Server unreachable',
        'The check-in timer needs a server connection to fire alerts. Check your server URL in Settings.',
      );
      return;
    }
    const name = await getUserName();
    const id = randomId('checkin');
    let latitude: number | null = null;
    let longitude: number | null = null;
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (granted) {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        latitude = loc.coords.latitude;
        longitude = loc.coords.longitude;
      }
    } catch {}
    try {
      const res = await fetchWithAuth(`${serverUrl}/checkin/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, phones, name, durationSeconds, latitude, longitude }),
      });
      if (!res.ok) throw new Error('Server error');
      const { expiresAt } = await res.json();
      checkInId.current = id;
      checkInExpiresAt.current = expiresAt;
      await AsyncStorage.setItem(CHECKIN_KEY, JSON.stringify({ id, expiresAt }));
      const notifId = await scheduleCheckInWarning(expiresAt);
      checkInNotifId.current = notifId;
      if (notifId) await AsyncStorage.setItem(CHECKIN_NOTIF_KEY, notifId);
      setCheckInRemaining(durationSeconds);
      setCheckInActive(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // Read the expiry from the ref (not the captured `expiresAt`) so "+15 min"
      // — which updates checkInExpiresAt.current — is reflected in the countdown.
      checkInIntervalRef.current = setInterval(() => {
        const r = Math.max(0, Math.round(((checkInExpiresAt.current || 0) - Date.now()) / 1000));
        setCheckInRemaining(r);
        if (r === 0) {
          if (checkInIntervalRef.current) clearInterval(checkInIntervalRef.current);
          setCheckInActive(false);
          AsyncStorage.removeItem(CHECKIN_KEY);
        }
      }, 1000);
    } catch {
      Alert.alert('Could not start timer', 'Check your server connection in Settings.');
    } finally {
      setCheckInStarting(false);
    }
  };

  const cancelCheckIn = async (notifySafe = false) => {
    if (checkInIntervalRef.current) clearInterval(checkInIntervalRef.current);
    setCheckInActive(false);
    setCheckInRemaining(0);
    await AsyncStorage.multiRemove([CHECKIN_KEY, CHECKIN_NOTIF_KEY]);
    await cancelCheckInWarning(checkInNotifId.current);
    checkInNotifId.current = null;
    const id = checkInId.current;
    checkInId.current = null;
    if (!id) return;
    const serverUrl = await getServerUrl();
    fetchWithAuth(`${serverUrl}/checkin/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, notifySafe }),
    }).catch(() => {});
  };

  const extendCheckIn = async () => {
    if (!checkInId.current) return;
    const serverUrl = await getServerUrl();
    try {
      const res = await fetchWithAuth(`${serverUrl}/checkin/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: checkInId.current, additionalSeconds: 15 * 60 }),
      });
      if (res.ok) {
        const { expiresAt } = await res.json();
        checkInExpiresAt.current = expiresAt;
        await AsyncStorage.setItem(CHECKIN_KEY, JSON.stringify({ id: checkInId.current, expiresAt }));
        await cancelCheckInWarning(checkInNotifId.current);
        const notifId = await scheduleCheckInWarning(expiresAt);
        checkInNotifId.current = notifId;
        if (notifId) await AsyncStorage.setItem(CHECKIN_NOTIF_KEY, notifId);
        else await AsyncStorage.removeItem(CHECKIN_NOTIF_KEY);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {}
  };

  // ── Go live ────────────────────────────────────────────────────────────────
  const handleSafetyTap = async (recordSeconds: number) => {
    recordDurationSecRef.current = recordSeconds;
    // Request camera/mic imperatively at go-live time. We deliberately avoid the
    // useCameraPermissions()/useMicrophonePermissions() hooks so nothing probes
    // the camera while the app is just sitting on Home.
    let cam = await Camera.getCameraPermissionsAsync();
    if (!cam.granted) cam = await Camera.requestCameraPermissionsAsync();
    if (!cam.granted) {
      permissionDeniedAlert(
        'Camera permission needed',
        'Allow camera access to record video during safety sessions. If you previously declined, turn it on in Settings.',
      );
      return;
    }
    let mic = await Camera.getMicrophonePermissionsAsync();
    if (!mic.granted) mic = await Camera.requestMicrophonePermissionsAsync();
    if (!mic.granted) {
      permissionDeniedAlert(
        'Microphone permission needed',
        'Allow microphone access to record audio. If you previously declined, turn it on in Settings.',
      );
      return;
    }
    const { granted: locFg } = await Location.requestForegroundPermissionsAsync();
    if (!locFg) {
      permissionDeniedAlert(
        'Location permission needed',
        'Allow location access to broadcast your GPS to your safety circle. If you previously declined, turn it on in Settings.',
      );
      return;
    }
    // Background ("Always") location: asked here, in context, only if not yet
    // granted. If declined we still go live — location just stops updating when
    // the phone locks or the app is switched away (foreground-only fallback).
    if (!IS_WEB) {
      const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
      if (bg && !bg.granted && bg.canAskAgain) {
        await Location.requestBackgroundPermissionsAsync().catch(() => null);
      }
    }
    const serverUrl = await getServerUrl();
    const serverOk = await checkServerHealth(serverUrl);
    if (!serverOk) {
      const proceed = await new Promise<boolean>(resolve =>
        Alert.alert(
          'Server unreachable',
          "Your safety circle won't receive alerts until the server is back online. You can update the server address in Settings.\n\nProceed anyway?",
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Proceed anyway', style: 'destructive', onPress: () => resolve(true) },
          ],
          { cancelable: false },
        ),
      );
      if (!proceed) return;
    }

    if (checkInActive) cancelCheckIn(false);
    notifiedRef.current = false;
    setNotifyStatus('idle');

    // Start the session exactly once, with whatever location we have — possibly
    // null. A panic button must never silently no-op: if a GPS fix never arrives
    // (indoors, tunnel, GPS off), we still alert the circle with "location
    // pending" rather than sitting forever on "Acquiring GPS…".
    const beginSessionOnce = async (coords: Location.LocationObjectCoords | null) => {
      if (notifiedRef.current) return;
      notifiedRef.current = true;
      if (goLiveFallbackRef.current) {
        clearTimeout(goLiveFallbackRef.current);
        goLiveFallbackRef.current = null;
      }
      const sessionId = randomId('session');
      sessionIdRef.current = sessionId;
      await AsyncStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
      await startSession(coords);
      // Keep the session useful when the phone locks / app is switched away:
      // iOS won't record video in the background, but location + audio may
      // continue. Both are best-effort and never block going live.
      if (!IS_WEB) {
        startBackgroundLocation().catch(() => {});
        startBackgroundAudio().catch(() => {});
      }
    };

    // 1) Seed immediately from the last known fix, if the OS has one cached.
    const lastKnown = await Location.getLastKnownPositionAsync().catch(() => null);
    if (lastKnown) {
      setCoords(lastKnown.coords);
      beginSessionOnce(lastKnown.coords);
    }

    // 2) Watch live fixes — the first fix starts the session (if not already
    //    started); later fixes silently refresh the shared position.
    locationSub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 },
      async loc => {
        setCoords(loc.coords);
        if (!notifiedRef.current) {
          await beginSessionOnce(loc.coords);
        } else if (Date.now() - lastLocationUpdateRef.current >= 60_000) {
          lastLocationUpdateRef.current = Date.now();
          updateLocation(loc.coords);
        }
      },
    );

    // 3) Fallback: if nothing has fired within 8s, alert anyway with no coords.
    goLiveFallbackRef.current = setTimeout(() => {
      if (!notifiedRef.current) beginSessionOnce(null);
    }, 8000);

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setShowCamera(true);
  };

  // Saves the finished recording to the phone's photo library (camera roll) so
  // the user keeps their own copy. Native only — a browser has no photo library.
  // Uses write-only (add) permission on iOS, and never lets a failed save break
  // the safety flow (the MMS to the circle is what matters most).
  // Returns true if saved. Never throws; a failed save must not break the safety
  // flow, but we DO surface why (silently failing hid a real bug for days).
  const saveToCameraRoll = async (uri: string): Promise<boolean> => {
    if (IS_WEB) return false;
    try {
      let perm = await MediaLibrary.getPermissionsAsync(true);
      if (!perm.granted && perm.canAskAgain) perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        permissionDeniedAlert(
          'Photos permission needed',
          "Allow Make It Home to add to your Photos so each recording is saved to your camera roll. If you previously declined, turn it on in Settings.",
        );
        return false;
      }
      await MediaLibrary.saveToLibraryAsync(uri);
      return true;
    } catch (e: any) {
      Alert.alert('Could not save recording', String(e?.message ?? e));
      return false;
    }
  };

  // (Live-snapshot capture during recording was removed: on iOS, taking a still
  // on the shared AVCaptureSession mid-recording finalizes the movie file early
  // — the recording is the evidence and takes priority. Responders still get
  // live location and the "Download recording" link on the live page.)

  const handleCameraReady = async () => {
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    // Capture the session id now — handleEnd clears it before recordAsync resolves.
    const sessionId = sessionIdRef.current;
    // NOTE: the live-snapshot loop is intentionally NOT started while recording.
    // On iOS, takePictureAsync during recordAsync can abort the recording (no
    // video file at all). The recording is the evidence — it takes priority.
    // Responders still get live location + the "Download recording" link.

    // The chosen recording length is enforced by a wall-clock timer, NOT by
    // recordAsync resolving — on some devices recordAsync can settle early, and
    // we must not tear the session down the instant it does.
    const seconds = recordDurationSecRef.current;
    if (recordEndTimerRef.current) clearTimeout(recordEndTimerRef.current);
    recordEndTimerRef.current = setTimeout(() => {
      if (isRecordingRef.current) finishSession('auto');
    }, seconds * 1000);

    // Start recording, retrying briefly on "Camera is not ready yet". On iOS the
    // native movie output is attached in setCameraMode() (a prop update after
    // mount), which can land a beat AFTER onCameraReady fires — so the very first
    // recordAsync can hit CameraOutputNotReadyException. Retrying for ~3s covers
    // that race; without it we got no file at all.
    let video: { uri: string } | undefined;
    let recordError: string | null = null;
    const startedAt = Date.now();
    // Small settle so the movie output exists on the first attempt in most cases.
    await new Promise(r => setTimeout(r, 400));
    for (let attempt = 0; ; attempt++) {
      if (!isRecordingRef.current) break; // user ended before we ever started
      try {
        // maxDuration is a backstop cap at the camera level.
        video = await cameraRef.current?.recordAsync({ maxDuration: seconds });
        recordError = null;
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const notReady = /not ready/i.test(msg);
        if (notReady && Date.now() - startedAt < 3000) {
          await new Promise(r => setTimeout(r, 250));
          continue; // camera output not attached yet — try again
        }
        // A manual End rejects on some platforms — that's fine. Anything else is
        // real, and losing the recording silently is exactly what we must not do.
        recordError = /stop|cancel/i.test(msg) ? null : msg;
        break;
      }
    }
    if (recordError) Alert.alert('Recording problem', recordError);

    if (video?.uri) {
      const saved = await saveToCameraRoll(video.uri); // keep a copy on the device
      if (saved) setNotifyStatus('saved');
      await uploadRecording(video.uri, sessionId); // send it to the safety circle
    } else if (!recordError && isRecordingRef.current) {
      // Resolved with no file and no error — surface it instead of a silent miss.
      Alert.alert(
        'No video was recorded',
        'The camera stopped without producing a file. This can happen in Expo Go; it works in the installed app.',
      );
    }
    // Do NOT finish here — the wall-clock timer (or a manual End) owns the
    // session lifecycle.
  };

  const sendSafeNotification = async () => {
    const phones = await getSafetyCirclePhones();
    if (phones.length === 0) return;
    await syncCircle(phones); // guarantee the server has this circle under the current token
    const [serverUrl, name] = await Promise.all([getServerUrl(), getUserName()]);
    fetchWithAuth(`${serverUrl}/safe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phones, name }),
    }).catch(() => {});
  };

  // Ends the live session. reason 'manual' = the user tapped End (we stop the
  // recording); reason 'auto' = the recording already finished at its chosen
  // length (nothing to stop). Guarded so the two paths can't double-run.
  const finishSession = (reason: 'manual' | 'auto') => {
    if (!showCamera && !sessionIdRef.current) return;
    const endedSessionId = sessionIdRef.current;
    if (goLiveFallbackRef.current) {
      clearTimeout(goLiveFallbackRef.current);
      goLiveFallbackRef.current = null;
    }
    if (recordEndTimerRef.current) {
      clearTimeout(recordEndTimerRef.current);
      recordEndTimerRef.current = null;
    }
    if (reason === 'manual') cameraRef.current?.stopRecording();
    locationSub.current?.remove();
    locationSub.current = null;
    // Stop background systems. The background audio is the evidence that
    // survived the phone being locked. iOS Photos can't hold audio files, so we
    // keep it in the app's storage and offer the OS share sheet (save to Files,
    // AirDrop, send to police) once the "safe?" prompt is answered.
    if (!IS_WEB) {
      stopBackgroundLocation().catch(() => {});
      stopBackgroundAudio()
        .then(uri => {
          if (uri) lastAudioUriRef.current = uri;
        })
        .catch(() => {});
    }
    AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    if (endedSessionId) {
      getServerUrl().then(serverUrl => {
        fetchWithAuth(`${serverUrl}/session/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: endedSessionId }),
        }).catch(() => {});
      });
    }
    setIsRecording(false);
    setShowCamera(false);
    setCoords(null);
    notifiedRef.current = false;
    sessionIdRef.current = null;
    lastLocationUpdateRef.current = 0;
    isRecordingRef.current = false;
    setTimeout(() => setNotifyStatus('idle'), 3000);
    Alert.alert(
      reason === 'auto' ? 'Recording finished' : 'Session ended',
      "Let your safety circle know you're safe?",
      [
        { text: "Yes, I'm safe", onPress: () => { sendSafeNotification(); offerBackgroundAudio(); } },
        { text: 'No thanks', style: 'cancel', onPress: offerBackgroundAudio },
      ],
    );
  };

  // If audio was captured while the phone was locked / app backgrounded, offer to
  // keep it. Photos can't store audio, so this uses the OS share sheet (Save to
  // Files, AirDrop, Messages...). Best-effort; skipped if there's no file.
  const offerBackgroundAudio = () => {
    const uri = lastAudioUriRef.current;
    if (!uri || IS_WEB) return;
    lastAudioUriRef.current = null;
    // Give the "safe?" alert a moment to dismiss before presenting another.
    setTimeout(() => {
      Alert.alert(
        'Audio was captured too',
        'While your phone was locked or you were in another app, Make It Home kept recording audio. Save it as evidence?',
        [
          {
            text: 'Save / share',
            onPress: async () => {
              try {
                const Sharing = await import('expo-sharing');
                if (await Sharing.isAvailableAsync()) {
                  await Sharing.shareAsync(uri, { mimeType: 'audio/m4a', dialogTitle: 'Save session audio' });
                }
              } catch {}
            },
          },
          { text: 'Not now', style: 'cancel' },
        ],
      );
    }, 400);
  };

  const handleEnd = () => finishSession('manual');

  // ── Beacon gesture ─────────────────────────────────────────────────────────
  // Hold the beacon and drag toward a recording length (15/30/45/60 min); release
  // there to go live and record for that long. Releasing near the center cancels.
  const onBeaconRelease = (k: string | null) => {
    if (!k || !DIR[k]) return; // released in the center — do nothing
    if (circleCount === 0) {
      // Alert.alert is a no-op on react-native-web, so give web its own prompt.
      if (IS_WEB) {
        if (typeof window !== 'undefined' &&
            window.confirm('No one is in your safety circle yet.\n\nAdd someone so an alert can reach them?')) {
          router.push('/(tabs)/contacts');
        }
      } else {
        Alert.alert(
          'No one in your circle',
          'Add someone to your safety circle first so an alert can actually reach them.',
          [
            { text: 'Add someone', onPress: () => router.push('/(tabs)/contacts') },
            { text: 'Cancel', style: 'cancel' },
          ],
        );
      }
      return;
    }
    handleSafetyTap(DIR[k].sec);
  };

  // Keep the latest release handler reachable from the (memoized) gesture.
  const releaseRef = useRef(onBeaconRelease);
  useEffect(() => {
    releaseRef.current = onBeaconRelease;
  });

  // Beacon gesture (touch + mouse) via react-native-gesture-handler. A single Pan
  // that doubles as a joystick: the beacon follows the thumb (beaconXY) and the
  // drag direction selects a recording length. Release on a direction to go live;
  // release near center to cancel. Springs back on release.
  const MAX_DRAG = 88;
  const beaconGesture = useRef(
    Gesture.Pan()
      .runOnJS(true)
      .hitSlop(20)
      .onBegin(() => {
        selRef.current = null;
        setSel(null);
        setArmed(true);
        if (!IS_WEB) Haptics.selectionAsync();
      })
      .onUpdate(e => {
        const dx = e.translationX;
        const dy = e.translationY;
        const dist = Math.hypot(dx, dy) || 1;
        // Move the beacon toward the thumb, clamped to a radius (joystick).
        const scale = dist > MAX_DRAG ? MAX_DRAG / dist : 1;
        beaconXY.setValue({ x: dx * scale, y: dy * scale });
        // Select a direction once dragged past the threshold.
        let k: string | null = null;
        if (dist >= 42) {
          if (Math.abs(dx) > Math.abs(dy)) k = dx < 0 ? 'left' : 'right';
          else k = dy < 0 ? 'up' : 'down';
        }
        if (k !== selRef.current) {
          selRef.current = k;
          setSel(k);
          if (k && !IS_WEB) Haptics.selectionAsync();
        }
      })
      .onEnd(() => {
        releaseRef.current(selRef.current);
      })
      .onFinalize(() => {
        setArmed(false);
        setSel(null);
        selRef.current = null;
        Animated.spring(beaconXY, { toValue: { x: 0, y: 0 }, useNativeDriver: false, bounciness: 8 }).start();
      }),
  ).current;

  // ── Camera / go-live screen ────────────────────────────────────────────────
  if (showCamera) {
    const statusColor =
      notifyStatus === 'error'
        ? '#f87171'
        : notifyStatus === 'uploading'
          ? Beacon.warn
          : notifyStatus === 'notified' || notifyStatus === 'uploaded' || notifyStatus === 'saved'
            ? Beacon.safe
            : Beacon.warn;
    const statusLabel =
      notifyStatus === 'notified'
        ? '✓ Circle notified — tracking live'
        : notifyStatus === 'saved'
          ? '✓ Saved to your camera roll'
        : notifyStatus === 'uploading'
          ? '⬆ Uploading recording…'
          : notifyStatus === 'uploaded'
            ? '✓ Recording sent'
            : notifyStatus === 'error'
              ? '⚠ Could not reach server'
              : coords
                ? 'Broadcasting location…'
                : 'Acquiring GPS…';
    return (
      <View style={styles.cameraRoot}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode="video"
          onCameraReady={handleCameraReady}
        />
        <SafeAreaView style={styles.cameraOverlay} pointerEvents="box-none">
          <View style={styles.recRow}>
            {isRecording && (
              <View style={styles.recBadge}>
                <View style={styles.recDot} />
                <Text style={styles.recLabel}>REC</Text>
              </View>
            )}
            <Text style={styles.recTimer}>{formatTime(elapsed)}</Text>
          </View>
          <View style={styles.camStatus}>
            {coords && (
              <Text style={styles.gpsText}>
                {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
              </Text>
            )}
            <Text style={[styles.camStatusLabel, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          <View style={styles.endWrap}>
            <PillButton title="End session" kind="dark" onPress={handleEnd} style={styles.endBtn} />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // ── Active check-in overlay ────────────────────────────────────────────────
  if (checkInActive) {
    const urgent = checkInRemaining < 120;
    const warning = checkInRemaining < 300 && checkInRemaining >= 120;
    return (
      <View style={styles.liveRoot}>
        <SafeAreaView style={styles.liveInner}>
          <Animated.View style={[styles.liveDot, { transform: [{ scale: livePulse }] }]} />
          <Text style={styles.liveTitle}>Check-in active</Text>
          <Text
            style={[
              styles.liveTimer,
              warning && { color: Beacon.warn },
              urgent && { color: '#f87171' },
            ]}>
            {formatTime(checkInRemaining)}
          </Text>
          <Text style={styles.liveSub}>
            If you don&apos;t check in, your circle is alerted with your location.
          </Text>
          <View style={styles.liveBtns}>
            <PillButton
              title="✓  I'm safe"
              kind="primary"
              onPress={() => cancelCheckIn(true)}
              style={{ flex: 1 }}
            />
            <PillButton title="+15 min" kind="dark" onPress={extendCheckIn} style={{ width: 110 }} />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // ── Home / beacon ──────────────────────────────────────────────────────────
  const covered = circleCount > 0;
  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.hbar}>
        <Text style={styles.mark}>
          Make It <Text style={{ color: Beacon.beacon }}>Home</Text>
        </Text>
        <Pressable style={styles.gear} hitSlop={8} onPress={() => router.push('/(tabs)/explore')}>
          <Ionicons name="settings-outline" size={18} color={Beacon.muted} />
        </Pressable>
      </View>

      {/* Coverage strip */}
      <Pressable style={styles.cover} onPress={() => router.push('/(tabs)/contacts')}>
        <View
          style={[
            styles.coverPip,
            {
              backgroundColor: covered ? Beacon.safe : Beacon.amber,
              shadowColor: covered ? Beacon.safe : Beacon.amber,
            },
          ]}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.coverTitle}>{covered ? "You're covered" : 'Almost ready'}</Text>
          <Text style={styles.coverSub}>
            {covered
              ? `${circleCount} ${circleCount === 1 ? 'person has' : 'people have'} your back`
              : 'Add someone — no one is alerted yet'}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      {/* Map placeholder */}
      <View style={styles.map}>
        <View style={styles.mapRoad} />
        <View style={styles.mapRoad2} />
        <Animated.View style={[styles.mapPin, { transform: [{ scale: livePulse }] }]} />
        <View style={styles.mapTag}>
          <Text style={styles.mapTagText}>
            <Text style={{ color: locGranted ? Beacon.safe : '#ff8a6e' }}>● </Text>
            {locGranted ? 'Live location ready' : 'Location off'}
          </Text>
        </View>
      </View>

      {/* Beacon — hold + joystick-drag to a recording length, release to go live.
          The gesture is attached to ONLY the orange button so a touch elsewhere on
          the home screen can't accidentally trigger an alert. */}
      <View style={styles.arena}>
        <BeaconChip label="15" active={sel === 'left'} visible={armed} style={styles.optLeft} />
        <BeaconChip label="30" active={sel === 'up'} visible={armed} style={styles.optUp} />
        <BeaconChip label="45" active={sel === 'right'} visible={armed} style={styles.optRight} />
        <BeaconChip label="60" active={sel === 'down'} visible={armed} style={styles.optDown} />
        <GestureDetector gesture={beaconGesture}>
          <Animated.View
            style={[
              styles.beacon,
              // Only the "armed" (hot) colour when a length is actually selected.
              // At the centre with nothing selected, it reads as a cancel target.
              armed && sel && styles.beaconArmed,
              armed && !sel && styles.beaconCancel,
              {
                transform: [
                  { translateX: beaconXY.x },
                  { translateY: beaconXY.y },
                  { scale: armed ? 1 : pulse },
                ],
              },
            ]}>
            <Text style={styles.beaconText}>{armed ? (sel ? DIR[sel].label : 'Cancel') : 'Hold'}</Text>
            <Text style={styles.beaconSub}>
              {armed ? (sel ? 'min · release' : 'release here') : '& drag'}
            </Text>
          </Animated.View>
        </GestureDetector>
      </View>

      <Text style={styles.undertext}>
        Hold the beacon and drag to how long to record (15 / 30 / 45 / 60 min), then release to go
        live.
      </Text>

      {/* Home-safe check-in — separate from go-live. Alerts your circle if you
          don't tap "I'm safe" before the timer runs out. */}
      <View style={styles.checkInWrap}>
        {showCheckIn ? (
          <View style={styles.checkInChips}>
            {[15, 30, 45, 60].map(min => (
              <Pressable
                key={min}
                style={styles.ciChip}
                onPress={() => {
                  setShowCheckIn(false);
                  startCheckIn(min * 60);
                }}>
                <Text style={styles.ciChipText}>{min}m</Text>
              </Pressable>
            ))}
            <Pressable style={styles.ciCancel} onPress={() => setShowCheckIn(false)}>
              <Ionicons name="close" size={16} color={Beacon.muted} />
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.checkInBtn} onPress={() => setShowCheckIn(true)}>
            <Ionicons name="timer-outline" size={16} color={Beacon.muted} />
            <Text style={styles.checkInText}>
              {checkInStarting ? 'Starting check-in…' : 'Set a Home-safe check-in'}
            </Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function BeaconChip({
  label,
  active,
  visible,
  style,
}: {
  label: string;
  active: boolean;
  visible: boolean;
  style: any;
}) {
  if (!visible) return null;
  return (
    <View style={[styles.opt, active && styles.optActive, style]} pointerEvents="none">
      <Text style={[styles.optText, active && { color: '#fff' }]}>
        {label}
        <Text style={styles.optUnit}>min</Text>
      </Text>
    </View>
  );
}

const BEACON_SIZE = 168;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night, paddingHorizontal: 20 },

  hbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  mark: { fontWeight: '800', fontSize: 17, color: Beacon.text, letterSpacing: -0.2 },
  gear: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },

  cover: {
    marginTop: 16,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 16,
    paddingHorizontal: 15,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  coverPip: {
    width: 9,
    height: 9,
    borderRadius: 5,
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 3,
  },
  coverTitle: { fontSize: 14, fontWeight: '700', color: Beacon.text },
  coverSub: { fontSize: 12, color: Beacon.muted, marginTop: 1 },
  chevron: { color: Beacon.faint, fontSize: 20 },

  map: {
    marginTop: 12,
    height: 104,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Beacon.line,
    backgroundColor: '#0f1a28',
  },
  mapRoad: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '38%',
    width: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    transform: [{ skewX: '-14deg' }],
  },
  mapRoad2: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '60%',
    height: 9,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  mapPin: {
    position: 'absolute',
    left: '50%',
    top: '48%',
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: 7,
    backgroundColor: Beacon.beacon,
    shadowColor: Beacon.beacon,
    shadowOpacity: 0.7,
    shadowRadius: 10,
    elevation: 6,
  },
  mapTag: {
    position: 'absolute',
    left: 10,
    bottom: 9,
    backgroundColor: 'rgba(8,13,20,0.72)',
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  mapTagText: { fontSize: 10.5, fontWeight: '700', color: Beacon.text },

  arena: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
    // Prevents a mouse-drag on web from selecting text instead of driving the gesture.
    userSelect: 'none',
  },
  beacon: {
    width: BEACON_SIZE,
    height: BEACON_SIZE,
    borderRadius: BEACON_SIZE / 2,
    backgroundColor: Beacon.beacon,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Beacon.beacon,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 30,
    elevation: 14,
  },
  beaconArmed: { backgroundColor: '#ff5238' },
  beaconCancel: { backgroundColor: '#3a4655' }, // neutral: release here to cancel
  beaconText: { color: '#fff', fontWeight: '800', fontSize: 20 },
  beaconSub: { color: 'rgba(255,255,255,0.9)', fontWeight: '600', fontSize: 11, marginTop: 2 },

  opt: {
    position: 'absolute',
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
    zIndex: 4,
  },
  optActive: { backgroundColor: Beacon.beacon, borderColor: Beacon.beacon },
  optText: { fontSize: 12, fontWeight: '800', color: Beacon.muted },
  optUnit: { fontSize: 9 },
  optLeft: { left: 0, top: '50%', marginTop: -15 },
  optUp: { top: 0 },
  optRight: { right: 0, top: '50%', marginTop: -15 },
  optDown: { bottom: 0 },

  undertext: {
    color: Beacon.muted,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 12,
    alignSelf: 'center',
    maxWidth: 260,
    lineHeight: 17,
  },

  // Home-safe check-in launcher
  checkInWrap: { alignItems: 'center', marginBottom: 16, minHeight: 44, justifyContent: 'center' },
  checkInBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  checkInText: { color: Beacon.text, fontSize: 13, fontWeight: '600' },
  checkInChips: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ciChip: {
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  ciChipText: { color: Beacon.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ciCancel: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
  },

  // Camera / go-live
  cameraRoot: { flex: 1, backgroundColor: '#000' },
  cameraOverlay: { flex: 1, justifyContent: 'space-between' },
  recRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginTop: 8,
  },
  recBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    gap: 6,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Beacon.hot },
  recLabel: { color: '#fff', fontWeight: 'bold', fontSize: 13, letterSpacing: 1 },
  recTimer: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  camStatus: { alignItems: 'center', gap: 4 },
  gpsText: {
    color: '#fff',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  camStatusLabel: {
    fontSize: 12,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  endWrap: { alignItems: 'center', marginBottom: 24 },
  endBtn: { width: 200 },

  // Live check-in overlay
  liveRoot: { flex: 1, backgroundColor: '#140b0e' },
  liveInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 14,
  },
  liveDot: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Beacon.hot,
    shadowColor: Beacon.hot,
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 12,
  },
  liveTitle: { fontSize: 20, fontWeight: '800', color: Beacon.text },
  liveTimer: { fontSize: 46, fontWeight: '800', color: Beacon.text, fontVariant: ['tabular-nums'] },
  liveSub: { fontSize: 12.5, color: Beacon.muted, textAlign: 'center', maxWidth: 260 },
  liveBtns: { flexDirection: 'row', gap: 12, marginTop: 8, width: '100%' },
});
