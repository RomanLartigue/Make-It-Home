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
import { BACKGROUND_LOCATION_TASK } from '@/tasks/backgroundLocation';
import { Beacon } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';

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
    'idle' | 'notified' | 'uploading' | 'uploaded' | 'error'
  >('idle');

  const cameraRef = useRef<CameraView>(null);
  const locationSub = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const lastLocationUpdateRef = useRef(0);
  const isRecordingRef = useRef(false);
  const goLiveFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const selRef = useRef<string>('now');
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
        Animated.timing(pulse, {
          toValue: 1.06,
          duration: 1300,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.ease),
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1300,
          useNativeDriver: true,
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
        Animated.timing(livePulse, { toValue: 1.1, duration: 700, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
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
    const [serverUrl, name] = await Promise.all([getServerUrl(), getUserName()]);
    const sessionId = sessionIdRef.current;
    lastLocationUpdateRef.current = Date.now();
    try {
      const res = await fetchWithAuth(`${serverUrl}/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          phones,
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

  const uploadRecording = async (videoUri: string) => {
    const phones = await getSafetyCirclePhones();
    if (phones.length === 0) return;
    await syncCircle(phones); // guarantee the server has this circle under the current token
    setNotifyStatus('uploading');
    const serverUrl = await getServerUrl();
    const formData = new FormData();
    formData.append('video', { uri: videoUri, type: 'video/mp4', name: 'recording.mp4' } as any);
    formData.append('phones', JSON.stringify(phones));
    try {
      const res = await fetchWithAuth(`${serverUrl}/upload`, { method: 'POST', body: formData });
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
  const handleSafetyTap = async () => {
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
    // Background location isn't available in Expo Go and can throw there — never
    // let it break go-live; foreground tracking + the alert still work without it.
    let bgGranted = false;
    try {
      bgGranted = (await Location.requestBackgroundPermissionsAsync()).granted;
    } catch {
      // ignore — proceed with foreground only
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
      if (bgGranted) {
        Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 30_000,
          distanceInterval: 20,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Make It Home is active',
            notificationBody: 'Your safety circle can track your location.',
            notificationColor: '#ff6a4d',
          },
        }).catch(err => console.warn('[BG Location] Start failed:', err.message));
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
  const saveToCameraRoll = async (uri: string) => {
    if (IS_WEB) return;
    try {
      let perm = await MediaLibrary.getPermissionsAsync(true);
      if (!perm.granted && perm.canAskAgain) perm = await MediaLibrary.requestPermissionsAsync(true);
      if (perm.granted) await MediaLibrary.saveToLibraryAsync(uri);
    } catch {
      // ignore — keeping a local copy is best-effort
    }
  };

  const handleCameraReady = async () => {
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    try {
      const video = await cameraRef.current?.recordAsync();
      if (video?.uri) {
        await saveToCameraRoll(video.uri); // keep a copy on the device
        await uploadRecording(video.uri); // send it to the safety circle
      }
    } catch {
      // stopRecording rejects the promise on some platforms — not a real error
    }
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

  const handleEnd = () => {
    const endedSessionId = sessionIdRef.current;
    if (goLiveFallbackRef.current) {
      clearTimeout(goLiveFallbackRef.current);
      goLiveFallbackRef.current = null;
    }
    cameraRef.current?.stopRecording();
    locationSub.current?.remove();
    locationSub.current = null;
    Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {});
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
    Alert.alert('Session ended', "Let your safety circle know you're safe?", [
      { text: "Yes, I'm safe", onPress: sendSafeNotification },
      { text: 'No thanks', style: 'cancel' },
    ]);
  };

  // ── Beacon gesture ─────────────────────────────────────────────────────────
  const onBeaconRelease = (k: string) => {
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
    if (k === 'now') handleSafetyTap();
    else if (DIR[k]) startCheckIn(DIR[k].sec);
  };

  // Keep the latest release handler reachable from the (memoized) PanResponder.
  const releaseRef = useRef(onBeaconRelease);
  useEffect(() => {
    releaseRef.current = onBeaconRelease;
  });

  // Beacon gesture (touch + mouse), via react-native-gesture-handler:
  //  • Tap  — a press/hold released without dragging = go live. A Tap fires the
  //    instant you lift your finger; a Pan does NOT "activate" on a no-drag tap
  //    on a touchscreen, which is why the old single-Pan version stayed armed and
  //    never triggered on release.
  //  • Pan  — a drag past the threshold selects a timer (fires on release).
  // Raced so exactly one wins: no drag → Tap; a drag → Pan.
  const beaconGesture = useRef(
    Gesture.Race(
      Gesture.Tap()
        .runOnJS(true)
        .maxDuration(60000) // allow a long hold-then-release to still count as a tap
        .maxDistance(24)
        .onStart(() => {
          releaseRef.current('now');
        }),
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(24)
        .onBegin(() => {
          selRef.current = 'now';
          setSel('now');
          setArmed(true);
          if (!IS_WEB) Haptics.selectionAsync();
        })
        .onUpdate(e => {
          const dx = e.translationX;
          const dy = e.translationY;
          let k = 'now';
          if (Math.hypot(dx, dy) >= 42) {
            if (Math.abs(dx) > Math.abs(dy)) k = dx < 0 ? 'left' : 'right';
            else k = dy < 0 ? 'up' : 'down';
          }
          if (k !== selRef.current) {
            selRef.current = k;
            setSel(k);
            if (!IS_WEB) Haptics.selectionAsync();
          }
        })
        .onEnd(() => {
          releaseRef.current(selRef.current);
        })
        .onFinalize(() => {
          setArmed(false);
          setSel(null);
        }),
    ),
  ).current;

  // ── Camera / go-live screen ────────────────────────────────────────────────
  if (showCamera) {
    const statusColor =
      notifyStatus === 'error'
        ? '#f87171'
        : notifyStatus === 'uploading'
          ? Beacon.warn
          : notifyStatus === 'notified' || notifyStatus === 'uploaded'
            ? Beacon.safe
            : Beacon.warn;
    const statusLabel =
      notifyStatus === 'notified'
        ? '✓ Circle notified — tracking live'
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

      {/* Beacon — hold-and-swipe (touch and mouse), via gesture-handler.
          userSelect:none keeps a mouse-drag from starting a text selection. */}
      <GestureDetector gesture={beaconGesture}>
        <View style={styles.arena}>
          <BeaconChip label="15" active={sel === 'left'} visible={armed} style={styles.optLeft} />
          <BeaconChip label="30" active={sel === 'up'} visible={armed} style={styles.optUp} />
          <BeaconChip label="45" active={sel === 'right'} visible={armed} style={styles.optRight} />
          <BeaconChip label="60" active={sel === 'down'} visible={armed} style={styles.optDown} />
          <Animated.View
            style={[
              styles.beacon,
              armed && styles.beaconArmed,
              { transform: [{ scale: armed ? 1 : pulse }] },
            ]}
            pointerEvents="none">
            <Text style={styles.beaconText}>Hold</Text>
            <Text style={styles.beaconSub}>{armed ? 'release' : '& swipe'}</Text>
          </Animated.View>
        </View>
      </GestureDetector>

      <Text style={styles.undertext}>
        {checkInStarting
          ? 'Starting check-in…'
          : 'Hold the beacon, then release in the center to go live — or drag to a timer (15 / 30 / 45 / 60 min)'}
      </Text>
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
    marginBottom: 16,
    alignSelf: 'center',
    maxWidth: 260,
    lineHeight: 17,
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
