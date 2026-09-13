import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Alert,
  AppState,
  Easing,
  Platform,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';

// Real-time broadcast screen is lazy-loaded: it pulls in react-native-webrtc,
// which has no JS-only fallback — importing it eagerly would crash Expo Go and
// the web build. Only loaded when a Gold LiveKit session actually starts.
const LiveKitPublisher = React.lazy(() =>
  import('@/components/beacon/LiveKitPublisher').then(m => ({ default: m.LiveKitPublisher })),
);
// Expo Go can't run the native WebRTC module, so LiveKit mode is disabled there.
const IS_EXPO_GO = Constants.appOwnership === 'expo';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { useRouter, useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { hTick, hArm, hConfirm, hWarning, hSuccess, hTap } from '@/utils/haptics';
import { CameraView, Camera } from 'expo-camera';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getServerUrl, getUserName, fetchWithAuth, randomId, syncCircle } from '@/utils/serverUrl';
import { Beacon } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';
import { ESCALATION_SCHEDULE_KEY, DEFAULT_SCHEDULE, normalizeSchedule } from '@/constants/escalation';
import * as FileSystem from 'expo-file-system/legacy';

import { startBackgroundLocation, stopBackgroundLocation } from '@/tasks/backgroundLocation';
import { isGold, useGold } from '@/utils/gold';
import { startChunkedAudio, stopChunkedAudio } from '@/utils/backgroundAudio';

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
// Recordings captured during a live session but not yet uploaded. Held here (and
// mirrored to disk) so nothing uploads until the session actually ends — and so a
// force-quit / dead battery mid-session still uploads on the next app launch.
const PENDING_MEDIA_KEY = '@makeithome_pending_media';

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
// (round 0), then re-texted after each scheduled wait until the USER marks safe.
// Every round targets the SAME whole circle. Returns null when the circle is empty.
//
// Free schedule = thirds of the slide time (4 alerts total): slide 30 min →
// alerts at 0 / 10 / 20 / 30. Gold keeps full custom control of the schedule.
async function getEscalationTiers(slideSeconds: number): Promise<
  { name: string; waitMinutes: number; phones: string[] }[] | null
> {
  const [rawCircle, rawSchedule] = await Promise.all([
    AsyncStorage.getItem(SAFETY_CIRCLE_KEY),
    AsyncStorage.getItem(ESCALATION_SCHEDULE_KEY),
  ]);
  const circle: any[] = rawCircle ? JSON.parse(rawCircle) : [];
  const phones = circle.map(c => c.phone).filter(Boolean);
  if (!phones.length) return null;
  const gold = await isGold();
  let schedule: number[];
  if (gold) {
    schedule = normalizeSchedule(rawSchedule ? JSON.parse(rawSchedule) : DEFAULT_SCHEDULE);
  } else {
    const third = Math.max(1, Math.round(slideSeconds / 180)); // ⅓ of the slide, in minutes
    schedule = [third, third, third];
  }
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
  const goldActive = useGold();

  // Home / cover state
  const [circleCount, setCircleCount] = useState(0);
  const [locGranted, setLocGranted] = useState(false);

  // Session (go-live) state
  const [showCamera, setShowCamera] = useState(false);
  // Which go-live surface to show. 'deciding' = we're still choosing LiveKit vs
  // camera (must NOT mount the camera yet, or its recording path fires by
  // mistake); 'livekit' = real-time stream; 'camera' = snapshot/segment fallback.
  const [liveMode, setLiveMode] = useState<'deciding' | 'livekit' | 'camera'>('deciding');
  // The slide time ran out without an "I'm safe" — the session KEEPS going and
  // both sides cycle: the server re-alerts the circle every 5 min, the app
  // re-asks the user "Are you safe?" every 5 min. Only "I'm safe" stops it.
  const [overdue, setOverdue] = useState(false);
  // Someone on the live page tapped "I'm on my way" (informational only — it
  // never stops the alerts; only the user can).
  const [ackByCircle, setAckByCircle] = useState(false);
  // Set when the session runs as a LiveKit live stream. Holds the connection
  // info for the publisher screen.
  const [liveKit, setLiveKit] = useState<{ url: string; token: string } | null>(null);
  const liveKitModeRef = useRef(false);
  const [isRecording, setIsRecording] = useState(false);
  const [cameraPaused, setCameraPaused] = useState(false); // app backgrounded: camera off, audio+GPS on
  const [elapsed, setElapsed] = useState(0);
  const [coords, setCoords] = useState<Location.LocationObjectCoords | null>(null);
  const [notifyStatus, setNotifyStatus] = useState<
    'idle' | 'notified' | 'saved' | 'uploading' | 'uploaded' | 'error' | 'reconnecting' | 'resumed'
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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // session/start retry
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null); // mid-session server watchdog
  const lastServerOkRef = useRef(0); // last time the server answered us during a session
  const recreatedRef = useRef(false); // whether this session was re-created after the server lost it
  const coordsRef = useRef<{ latitude: number; longitude: number } | null>(null); // latest fix, for the heartbeat
  // Recordings held for upload-at-end (video segments + background-audio stretches).
  const pendingMediaRef = useRef<{ uri: string; kind: 'video' | 'audio'; lat: number | null; lng: number | null; dur?: number }[]>([]);
  const loopDoneRef = useRef<Promise<void> | null>(null); // resolves when the segment loop exits
  const finishingRef = useRef(false); // guards finishSession against double-run (timer + manual)
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null); // live-frame loop
  const cycleIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null); // 5-min "Are you safe?" cycle
  const ackSeenRef = useRef(false); // already surfaced "someone is on their way"
  const frameBusyRef = useRef(false); // skip a tick if the previous capture/upload is still going
  const frameErrTracedRef = useRef(false); // trace the first capture error only (not one per tick)
  const recordStartedAtRef = useRef(0); // when the current recordAsync began (frames wait for stability)

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

  // Mirror the latest fix into a ref so the heartbeat interval (created once
  // per session) always reads fresh coordinates, not a stale closure.
  useEffect(() => {
    coordsRef.current = coords ? { latitude: coords.latitude, longitude: coords.longitude } : null;
  }, [coords]);

  // Breadcrumbs to the server log for the background lifecycle — the ONLY way to
  // see what actually happens on a phone once the app leaves the foreground.
  const trace = (message: string) => {
    getServerUrl()
      .then(serverUrl =>
        fetchWithAuth(`${serverUrl}/clientlog`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phase: 'session-trace',
            name: sessionIdRef.current || 'no-session',
            message,
          }),
        }),
      )
      .catch(() => {});
  };

  // Background/foreground breadcrumbs during a session. The chunked audio
  // recorder runs continuously from go-live (its always-active recording is
  // what keeps iOS from suspending the app in the background), so nothing
  // needs starting here anymore.
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (!sessionIdRef.current || IS_WEB) return;
      if (s === 'background') trace('bg-enter');
      else if (s === 'active') trace('fg-return');
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume-on-launch: if a previous session was force-quit or the phone died
  // mid-session, clear its leftover state (and end the orphaned server session
  // so escalations stop).
  useEffect(() => {
    (async () => {
      // An ACTIVE_SESSION_KEY at launch means the app was KILLED mid-session
      // (force-quit, dead battery, iOS terminated it). This cleanup must run
      // for EVERY such session — LiveKit sessions and pre-first-segment camera
      // sessions leave no pending media, but still have a live server session
      // (escalations firing) and a running background-location task.
      const orphanSession = await AsyncStorage.getItem(ACTIVE_SESSION_KEY).catch(() => null);
      const raw = await AsyncStorage.getItem(PENDING_MEDIA_KEY).catch(() => null);
      let parsed: { sessionId: string | null; items: any[] } | null = null;
      if (raw) {
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
      }
      const hasMedia = !!(parsed && Array.isArray(parsed.items) && parsed.items.length > 0);
      if (!orphanSession && !hasMedia) {
        if (raw) AsyncStorage.removeItem(PENDING_MEDIA_KEY).catch(() => {});
        return;
      }

      // 1) Stop the native background-location task — it survives relaunch and
      //    would otherwise keep GPS (and the blue indicator) running forever.
      if (!IS_WEB) stopBackgroundLocation().catch(() => {});

      // 2) Clear any held-segment queue from the dead session (segments already
      //    reached the camera roll as they were cut; nothing uploads).
      if (hasMedia && parsed) {
        trace(`relaunch-flush: ${parsed.items.length} item(s) from ${parsed.sessionId}`);
        pendingMediaRef.current = parsed.items;
        await flushPending(parsed.sessionId);
      } else if (raw) {
        AsyncStorage.removeItem(PENDING_MEDIA_KEY).catch(() => {});
      }

      // 3) End the orphaned server session so escalations stop.
      const sid = (parsed && parsed.sessionId) || orphanSession;
      if (sid) {
        trace(`relaunch-cleanup: ending orphan ${sid}`);
        const serverUrl = await getServerUrl();
        fetchWithAuth(`${serverUrl}/session/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        }).catch(() => {});
      }
      AsyncStorage.removeItem(ACTIVE_SESSION_KEY).catch(() => {});
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const startSession = async (loc: Location.LocationObjectCoords | null, livekit = false) => {
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
      getEscalationTiers(recordDurationSecRef.current),
    ]);
    const sessionId = sessionIdRef.current;
    lastLocationUpdateRef.current = Date.now();
    const body = JSON.stringify({
      sessionId,
      phones,
      // Staged escalation: first tier is alerted now, later tiers climb if no one
      // responds. Null → server alerts the whole circle at once.
      tiers,
      name,
      // May be null when we alert before a GPS fix — the live page shows
      // "Location pending…" and updates as fixes arrive.
      latitude: loc?.latitude ?? null,
      longitude: loc?.longitude ?? null,
      // Tells the server (and the responder page) this is a real-time stream.
      livekit,
    });

    // Keep trying to reach the server until the alert lands or the session ends —
    // a dropped connection must reconnect, not silently give up. Backoff caps at 20s.
    const attempt = async () => {
      try {
        const res = await fetchWithAuth(`${serverUrl}/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (res.ok) return 'ok';
        // 4xx = the server REFUSED the alert (rate cap, bad circle…). Retrying
        // the same request can never succeed — surface it LOUDLY instead. A
        // silently-failing panic alert is the worst possible failure mode.
        if (res.status >= 400 && res.status < 500) {
          const msg = (await res.json().catch(() => null))?.error;
          trace(`session-start-REFUSED (${res.status}): ${msg || ''}`);
          Alert.alert(
            '⚠️ Your circle was NOT alerted',
            `${msg || `The server refused the alert (HTTP ${res.status}).`}\n\nNo texts were sent. Fix the issue and go live again.`,
          );
          return 'refused';
        }
        return 'retry';
      } catch {
        return 'retry'; // network drop — retry with backoff
      }
    };
    let delay = 3000;
    const loop = async () => {
      if (sessionIdRef.current !== sessionId) return; // session ended — stop retrying
      const outcome = await attempt();
      if (sessionIdRef.current !== sessionId) return;
      if (outcome === 'ok') {
        setNotifyStatus('notified');
        return;
      }
      if (outcome === 'refused') {
        setNotifyStatus('error');
        return; // do NOT retry — the user has been told
      }
      setNotifyStatus('reconnecting');
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(loop, delay);
      delay = Math.min(Math.round(delay * 1.6), 20000);
    };
    await loop();
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
      })
        .then(res => {
          if (res.ok) {
            lastServerOkRef.current = Date.now();
            setNotifyStatus(s => (s === 'reconnecting' ? 'notified' : s));
          }
        })
        .catch(() => {});
    });
  };

  // Mid-session watchdog. The location watcher only POSTs when the phone MOVES
  // (distanceInterval) — so a dropped connection, or simply standing still,
  // would leave the responders' live page stale while the app still claims
  // "tracking live". Every 15s this pings /session/update with the latest fix:
  // failures flip the status to "reconnecting" and keep trying forever; success
  // flips it back. If the server LOST the session (restart), it is re-created
  // once — a repeat alert text beats a dead live link mid-emergency.
  // Live view for responders: every ~3s, capture a REAL still from the camera
  // (view/screen snapshots of a camera preview come back black on iOS — only
  // the camera itself has the pixels). expo-camera keeps its photo output
  // attached alongside the movie output in video mode, so stills during
  // recording are natively supported — and iOS keeps them silent while video
  // records. The one hazard is capturing while the movie output is still being
  // attached (what aborted recordings long ago), so frames wait until the
  // current recordAsync has been running for a few seconds.
  const FRAME_MS = 1500;
  const startFrameLoop = (sessionId: string) => {
    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameErrTracedRef.current = false;
    frameTimerRef.current = setInterval(async () => {
      if (sessionIdRef.current !== sessionId) return;
      if (!isRecordingRef.current || AppState.currentState !== 'active') return;
      if (Date.now() - recordStartedAtRef.current < 4000) return; // let recording stabilize
      if (frameBusyRef.current) return;
      frameBusyRef.current = true;
      try {
        const pic = await cameraRef.current?.takePictureAsync({
          quality: 0.2,
          base64: true,
          shutterSound: false,
        });
        if (!pic?.base64 || sessionIdRef.current !== sessionId) return;
        const serverUrl = await getServerUrl();
        await fetchWithAuth(`${serverUrl}/frame/${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: pic.base64,
        });
      } catch (e: any) {
        // best-effort — but surface the FIRST failure to the server log so a
        // black live view is diagnosable instead of a mystery.
        if (!frameErrTracedRef.current) {
          frameErrTracedRef.current = true;
          trace(`frame-capture-error: ${String(e?.message ?? e)}`);
        }
      } finally {
        frameBusyRef.current = false;
      }
    }, FRAME_MS);
  };

  const HEARTBEAT_MS = 15_000;
  const startHeartbeat = (sessionId: string) => {
    lastServerOkRef.current = Date.now();
    recreatedRef.current = false;
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(async () => {
      if (sessionIdRef.current !== sessionId) return;
      try {
        const serverUrl = await getServerUrl();
        const at = coordsRef.current;
        const res = await fetchWithAuth(`${serverUrl}/session/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            latitude: at?.latitude ?? null,
            longitude: at?.longitude ?? null,
          }),
        });
        if (sessionIdRef.current !== sessionId) return;
        if (res.ok) {
          lastServerOkRef.current = Date.now();
          setNotifyStatus(s => (s === 'reconnecting' ? 'notified' : s));
          // Surface "someone is on their way" to the USER too (once). It's
          // informational only — alerts keep going until the user is safe.
          const j = await res.json().catch(() => null);
          if (j?.acknowledged && !ackSeenRef.current) {
            ackSeenRef.current = true;
            setAckByCircle(true);
            hSuccess();
            Notifications.scheduleNotificationAsync({
              content: {
                title: '🟢 Help is on the way',
                body: 'Someone from your safety circle is coming to you.',
                sound: true,
              },
              trigger: null,
            }).catch(() => {});
          }
          return;
        }
        if (res.status === 404 && !recreatedRef.current) {
          recreatedRef.current = true;
          // Preserve the live-stream flag on re-creation, or the responder
          // page silently downgrades to snapshot mode (which LiveKit sessions
          // don't feed) — a dead live link mid-session.
          startSession(coordsRef.current as any, liveKitModeRef.current);
          return;
        }
      } catch {
        // unreachable — handled by the staleness check below
      }
      if (Date.now() - lastServerOkRef.current > HEARTBEAT_MS + 5000) {
        setNotifyStatus(s => (s === 'notified' || s === 'reconnecting' ? 'reconnecting' : s));
      }
    }, HEARTBEAT_MS);
  };

  // (Recording uploads removed: sessions are live-only. The circle watches in
  // real time and can screen-record the live page for a copy; camera-mode
  // segments still save to the user's own camera roll at zero server cost.)

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
      hConfirm();
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
        hTap();
      }
    } catch {}
  };

  // Ask the server for a LiveKit publisher token. Returns null (→ snapshot mode)
  // unless: real build (not Expo Go/web) and the server has LiveKit set up.
  // Real-time streaming is on for EVERYONE (investor-demo requirement) — not
  // gated to Gold. Any error falls back silently — live streaming must never
  // block go-live.
  const fetchLiveKitToken = async (sessionId: string): Promise<{ url: string; token: string } | null> => {
    if (IS_WEB || IS_EXPO_GO) return null;
    try {
      const serverUrl = await getServerUrl();
      const res = await fetchWithAuth(`${serverUrl}/livekit/publish-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) return null; // 503 = LiveKit not configured on the server
      const j = await res.json().catch(() => null);
      return j?.url && j?.token ? { url: j.url, token: j.token } : null;
    } catch {
      return null;
    }
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

      // Decide live mode: real-time LiveKit stream (Gold + server + real build)
      // or the snapshot/segment fallback. Best-effort — any failure falls back.
      const lk = await fetchLiveKitToken(sessionId);
      liveKitModeRef.current = !!lk;

      startHeartbeat(sessionId);
      await startSession(coords, !!lk);

      if (lk) {
        // LiveKit publishes camera + mic itself — no frame loop, no chunked
        // audio, no local recording pipeline. Just location alongside it.
        trace('livekit-mode');
        setLiveKit(lk);
        setLiveMode('livekit');
        setIsRecording(true);
        // At the chosen time the session does NOT end — it enters the overdue
        // "Are you safe?" cycle (stream keeps running until the user is safe).
        if (recordEndTimerRef.current) clearTimeout(recordEndTimerRef.current);
        recordEndTimerRef.current = setTimeout(() => {
          if (liveKitModeRef.current) enterOverdue();
        }, recordDurationSecRef.current * 1000);
        if (!IS_WEB) {
          startBackgroundLocation()
            .then(ok => trace(ok ? 'bg-location-started' : 'bg-location-FAILED'))
            .catch(() => trace('bg-location-FAILED'));
        }
        return;
      }

      // Snapshot / segment mode — now safe to mount the camera.
      setLiveMode('camera');
      startFrameLoop(sessionId);
      // Location keeps streaming when the phone locks / app is switched away.
      // Chunked audio runs for the WHOLE session (live sound for the circle +
      // the always-active recording keeps iOS from suspending the app in the
      // background). Both are best-effort and never block go-live.
      if (!IS_WEB) {
        startBackgroundLocation()
          .then(ok => trace(ok ? 'bg-location-started' : 'bg-location-FAILED'))
          .catch(() => trace('bg-location-FAILED'));
        startChunkedAudio(
          uri => uploadAudioChunk(uri, sessionId),
          msg => trace(`audio-chunk-error: ${msg}`),
        )
          .then(ok => trace(ok ? 'chunk-audio-started' : 'chunk-audio-DENIED'))
          .catch(() => {});
      }
    };

    // Show the "Going live…" screen BEFORE any session work starts — if
    // beginSessionOnce resolved first, its setLiveMode('livekit'|'camera')
    // would be clobbered back to 'deciding' below, stranding the user on the
    // spinner forever with no camera and no I'm-safe button.
    hWarning();
    setLiveMode('deciding'); // don't mount camera until the mode is chosen
    setShowCamera(true);

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

  // (Live frames DO run during camera-mode recording — see startFrameLoop:
  // takePictureAsync is safe once recordAsync has settled; the 4s hold-off
  // there keeps captures away from the movie-output attach window that used to
  // abort recordings.)

  // Resolves when the app is back in the foreground (or the deadline passes).
  const waitForForeground = (deadline: number) =>
    new Promise<void>(resolve => {
      if (AppState.currentState === 'active') return resolve();
      const timer = setTimeout(() => {
        sub.remove();
        resolve();
      }, Math.max(0, deadline - Date.now()));
      const sub = AppState.addEventListener('change', s => {
        if (s === 'active') {
          clearTimeout(timer);
          sub.remove();
          resolve();
        }
      });
    });

  // Live audio: each rolling ~5s clip uploads immediately so the circle's live
  // page can play sound a few seconds behind real time. One retry — chunks are
  // perishable, and the server only stitches what arrived.
  const uploadAudioChunk = async (uri: string, sessionId: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = new FormData();
        fd.append('chunk', { uri, type: 'audio/m4a', name: 'chunk.m4a' } as any);
        const serverUrl = await getServerUrl();
        const res = await fetchWithAuth(`${serverUrl}/audiochunk/${sessionId}`, {
          method: 'POST',
          body: fd,
        });
        if (res.ok || (res.status >= 400 && res.status < 500)) return;
      } catch {
        // retry once below
      }
      await new Promise(r => setTimeout(r, 800));
    }
  };

  // Hold a captured file for upload-at-end (mirrored to disk so a force-quit /
  // dead battery still uploads next launch). Nothing uploads until finishSession.
  const addPending = (uri: string, kind: 'video' | 'audio', dur?: number) => {
    pendingMediaRef.current.push({
      uri,
      kind,
      lat: coordsRef.current?.latitude ?? null,
      lng: coordsRef.current?.longitude ?? null,
      dur,
    });
    const sid = sessionIdRef.current;
    if (sid) {
      AsyncStorage.setItem(
        PENDING_MEDIA_KEY,
        JSON.stringify({ sessionId: sid, items: pendingMediaRef.current }),
      ).catch(() => {});
    }
  };

  // Recording delivery removed: nothing uploads at session end anymore. The
  // held-segment queue still exists so camera-mode segments reach the camera
  // roll; this just clears the on-disk queue when the session is done.
  const flushPending = async (_sessionId: string | null) => {
    pendingMediaRef.current = [];
    await AsyncStorage.removeItem(PENDING_MEDIA_KEY).catch(() => {});
  };

  const handleCameraReady = async () => {
    if (isRecordingRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    // Capture the session id now — handleEnd clears it before recordAsync resolves.
    const sessionId = sessionIdRef.current;
    // NOTE: live frames (startFrameLoop's takePictureAsync) run alongside the
    // recording — safe because the loop holds off 4s after each recordAsync
    // start, keeping captures clear of the movie-output attach window that
    // used to abort recordings.

    // At the chosen check-in time the session does NOT end — it enters the
    // overdue "Are you safe?" cycle, and recording continues until the user
    // presses "I'm safe". A wall-clock timer owns that transition.
    const seconds = recordDurationSecRef.current;
    if (recordEndTimerRef.current) clearTimeout(recordEndTimerRef.current);
    recordEndTimerRef.current = setTimeout(() => {
      if (isRecordingRef.current) enterOverdue();
    }, seconds * 1000);

    // Signal finishSession when this loop has fully exited (so it can flush the
    // final held segment before uploading).
    let resolveLoopDone: () => void = () => {};
    loopDoneRef.current = new Promise<void>(res => { resolveLoopDone = res; });

    // Small settle so the movie output exists on the first attempt in most cases.
    await new Promise(r => setTimeout(r, 400));

    // SEGMENT LOOP. iOS kills the camera the instant the app leaves the
    // foreground. That must NOT end the session: the partial video segment (with
    // sound) is HELD (not uploaded), audio-only recording takes over for the gap
    // (mic is free once the camera stops), and a new video recording starts when
    // the app is visible again. The loop runs until the user presses "I'm safe"
    // (finishSession) — segments are capped at 10 min each so files stay
    // manageable however long the session runs. Location streams throughout.
    const SEGMENT_MAX_SEC = 600;
    let segments = 0;
    while (isRecordingRef.current) {
      if (AppState.currentState !== 'active') {
        // App is backgrounded: the camera can't run, but the chunked audio and
        // location keep going on their own. Just wait to resume the video.
        setCameraPaused(true);
        trace('loop-paused');
        await waitForForeground(Date.now() + 6 * 60 * 60 * 1000);
        trace('loop-resumed');
        setCameraPaused(false);
        if (!isRecordingRef.current) break;
        // Tell the user the recording picked back up — otherwise the last
        // status ("saved") lingers and reads like the recording stopped.
        setNotifyStatus('resumed');
        // Give the camera a beat to re-attach its capture session.
        await new Promise(r => setTimeout(r, 600));
      }

      // Start recording, retrying briefly on "Camera is not ready yet". On iOS
      // the native movie output is attached in setCameraMode() (a prop update
      // after mount / foreground return), which can land a beat late — so
      // recordAsync can hit CameraOutputNotReadyException. Retry for ~4s.
      let video: { uri: string } | undefined;
      let recordError: string | null = null;
      const startedAt = Date.now();
      for (;;) {
        if (!isRecordingRef.current) break;
        try {
          recordStartedAtRef.current = Date.now(); // frames hold off while this settles
          video = await cameraRef.current?.recordAsync({ maxDuration: SEGMENT_MAX_SEC });
          recordError = null;
          break;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (/not ready/i.test(msg) && Date.now() - startedAt < 4000) {
            await new Promise(r => setTimeout(r, 250));
            continue; // camera output not attached yet — try again
          }
          // A manual End rejects on some platforms — that's fine. Anything else
          // is real, and losing the recording silently is what we must not do.
          recordError = /stop|cancel/i.test(msg) ? null : msg;
          break;
        }
      }
      if (recordError && segments === 0) Alert.alert('Recording problem', recordError);

      if (video?.uri) {
        segments++;
        const uri = video.uri;
        trace(`video-segment-${segments}-held`);
        // Keep a local copy immediately; HOLD the upload until session end.
        saveToCameraRoll(uri).then(saved => { if (saved) setNotifyStatus('saved'); }).catch(() => {});
        // Actual recorded length of THIS segment (not the chosen session length).
        addPending(uri, 'video', Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
      } else if (!recordError && isRecordingRef.current) {
        if (AppState.currentState !== 'active') continue; // backgrounded — wait and resume
        // Resolved with no file, no error, in the foreground — surface it
        // instead of a silent miss (and don't spin).
        if (segments === 0) {
          Alert.alert(
            'No video was recorded',
            'The camera stopped without producing a file. This can happen in Expo Go; it works in the installed app.',
          );
        }
        break;
      }
      // Tiny yield so an instantly-resolving camera can't hot-loop.
      await new Promise(r => setTimeout(r, 300));
    }
    setCameraPaused(false);
    resolveLoopDone(); // finishSession may be awaiting this before it flushes
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

  // The slide time ran out with no "I'm safe". The session does NOT end — it
  // shifts into the overdue cycle: the app asks "Are you safe?" now and every
  // 5 minutes (notification + on-screen banner), while the SERVER independently
  // re-alerts the circle with live location every 5 minutes. Recording and the
  // live stream keep running. Only the user pressing "I'm safe" stops it.
  const enterOverdue = () => {
    if (!sessionIdRef.current || finishingRef.current) return;
    setOverdue(true);
    hWarning();
    trace('overdue-cycle-start');
    const askAreYouSafe = () => {
      Notifications.scheduleNotificationAsync({
        content: {
          title: 'Are you safe?',
          body: "Your check-in time ran out. Tap I'm safe if you're okay — your circle is being re-alerted until you do.",
          sound: true,
        },
        trigger: null,
      }).catch(() => {});
    };
    askAreYouSafe();
    if (cycleIntervalRef.current) clearInterval(cycleIntervalRef.current);
    cycleIntervalRef.current = setInterval(() => {
      if (!sessionIdRef.current) return;
      hWarning();
      askAreYouSafe();
    }, 5 * 60 * 1000);
  };

  // Ends the live session. reason 'manual' = the user tapped End; reason 'auto'
  // = the chosen session length elapsed. Stops the streams and the segment
  // loop, then tears everything down. Guarded against double-run.
  const finishSession = (reason: 'manual' | 'auto') => {
    if (!showCamera && !sessionIdRef.current) return;
    if (finishingRef.current) return;
    finishingRef.current = true;
    trace(`finish-session: ${reason}`);
    const endedSessionId = sessionIdRef.current;
    const wasLiveKit = liveKitModeRef.current;
    liveKitModeRef.current = false;
    if (goLiveFallbackRef.current) {
      clearTimeout(goLiveFallbackRef.current);
      goLiveFallbackRef.current = null;
    }
    if (recordEndTimerRef.current) {
      clearTimeout(recordEndTimerRef.current);
      recordEndTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    if (cycleIntervalRef.current) {
      clearInterval(cycleIntervalRef.current);
      cycleIntervalRef.current = null;
    }
    // Stop the segment loop and unblock the in-progress recordAsync (both paths),
    // so the loop can push its final segment and resolve loopDoneRef.
    isRecordingRef.current = false;
    cameraRef.current?.stopRecording();
    locationSub.current?.remove();
    locationSub.current = null;
    const doneWaiter = loopDoneRef.current;

    // Do the heavy work off the UI path: wait for the loop's final segment and
    // stop background systems. Nothing uploads — sessions are live-only now.
    (async () => {
      if (!IS_WEB) stopBackgroundLocation().catch(() => {});
      if (wasLiveKit) return; // no local pipeline in LiveKit mode
      if (doneWaiter) {
        await Promise.race([doneWaiter, new Promise(r => setTimeout(r, 4000))]);
      }
      if (!IS_WEB) {
        // Wait (bounded) for the FINAL in-flight live-audio chunk so the live
        // page has the last seconds of sound.
        await Promise.race([stopChunkedAudio(), new Promise(r => setTimeout(r, 7000))]);
      }
      await flushPending(endedSessionId);
    })().catch(() => {});

    AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    // Ending the session halts the server's escalation sweep — so this MUST
    // land, not be best-effort. Retry with backoff until the server confirms
    // (or a 4xx says the session is already gone), so escalations can't keep
    // firing after the user ended or was confirmed safe.
    if (endedSessionId) {
      (async () => {
        const serverUrl = await getServerUrl();
        let delay = 3000;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const res = await fetchWithAuth(`${serverUrl}/session/end`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: endedSessionId }),
            });
            if (res.ok || (res.status >= 400 && res.status < 500)) return; // ended, or already gone
          } catch {
            // network drop — retry below
          }
          await new Promise(r => setTimeout(r, delay));
          delay = Math.min(Math.round(delay * 1.6), 20000);
        }
      })();
    }
    setIsRecording(false);
    setCameraPaused(false);
    setShowCamera(false);
    setLiveKit(null);
    setCoords(null);
    setOverdue(false);
    setAckByCircle(false);
    ackSeenRef.current = false;
    notifiedRef.current = false;
    sessionIdRef.current = null;
    lastLocationUpdateRef.current = 0;
    setTimeout(() => { finishingRef.current = false; }, 1500); // re-arm after teardown
    setTimeout(() => setNotifyStatus('idle'), 3000);
    hSuccess();
    // Pressing "I'm safe" IS the safe signal — tell the circle automatically
    // ("✅ <name> is safe."), no extra prompt. Only the user can end alerts,
    // and ending them means they're safe.
    sendSafeNotification();
    Alert.alert(
      "You're marked safe",
      wasLiveKit
        ? "Your circle has been told you're safe and the live stream has stopped."
        : "Your circle has been told you're safe. Video captured on this phone is in your camera roll.",
    );
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
    // A firm double-thump the moment the alert is committed — this is the app's
    // most important gesture, and it should FEEL like it landed.
    hConfirm();
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
        hTick();
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
          if (k) hArm(); // firm tick each time a new duration is selected
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

  // ── Going-live: still deciding which surface (never mount the camera here) ──
  if (showCamera && liveMode === 'deciding') {
    return (
      <View style={[styles.cameraRoot, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color="#fff" />
        <Text style={{ color: '#fff', marginTop: 14, fontWeight: '700', fontSize: 15 }}>Going live…</Text>
      </View>
    );
  }

  // ── LiveKit real-time broadcast screen ─────────────────────────────────────
  if (showCamera && liveMode === 'livekit' && liveKit) {
    return (
      <Suspense
        fallback={
          <View style={styles.cameraRoot}>
            <ActivityIndicator color="#fff" style={{ flex: 1 }} />
          </View>
        }
      >
        <LiveKitPublisher
          serverUrl={liveKit.url}
          token={liveKit.token}
          elapsed={elapsed}
          alertState={
            notifyStatus === 'error' ? 'failed' : notifyStatus === 'notified' ? 'ok' : 'sending'
          }
          overdue={overdue}
          ackByCircle={ackByCircle}
          onEnd={() => finishSession('manual')}
          onConnected={() => {
            // Deliberately does NOT touch notifyStatus: the WebRTC connection
            // succeeding says nothing about whether the circle was texted —
            // startSession owns that status, and overwriting a 'reconnecting'/
            // 'error' here would show "Circle alerted" when no texts went out.
            trace('livekit-connected');
            // Ask the server to record the room. The room + published tracks need
            // a moment to fully register in LiveKit before egress can attach, so
            // wait a beat, then retry a few times if it isn't recording yet.
            const sid = sessionIdRef.current;
            if (!sid) return;
            (async () => {
              const serverUrl = await getServerUrl();
              await new Promise(r => setTimeout(r, 2500));
              for (let attempt = 0; attempt < 4; attempt++) {
                if (sessionIdRef.current !== sid) return;
                try {
                  const res = await fetchWithAuth(`${serverUrl}/livekit/start-egress`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: sid }),
                  });
                  const j = await res.json().catch(() => null);
                  if (j?.recording) { trace('egress-started'); return; }
                  trace(`egress-retry-${attempt}`);
                } catch {
                  trace(`egress-error-${attempt}`);
                }
                await new Promise(r => setTimeout(r, 3000));
              }
              trace('egress-gaveup');
            })();
          }}
          onError={m => trace(`livekit-error: ${m}`)}
        />
      </Suspense>
    );
  }

  // ── Camera / go-live screen (snapshot fallback mode only) ──────────────────
  if (showCamera && liveMode === 'camera') {
    const statusColor = overdue
      ? '#f87171'
      : notifyStatus === 'error'
        ? '#f87171'
        : notifyStatus === 'uploading' || notifyStatus === 'reconnecting'
          ? Beacon.warn
          : notifyStatus === 'notified' || notifyStatus === 'uploaded' || notifyStatus === 'saved' || notifyStatus === 'resumed'
            ? Beacon.safe
            : Beacon.warn;
    const statusLabel = overdue
      ? "⚠ Are you safe? Tap I'm safe — your circle is being re-alerted"
      : cameraPaused
      ? '⏸ Camera paused — audio & location still recording'
      : notifyStatus === 'resumed'
        ? '● Recording continued — tracking live'
      : notifyStatus === 'notified'
        ? '✓ Circle notified — tracking live'
        : notifyStatus === 'saved'
          ? '✓ Saved to your camera roll'
        : notifyStatus === 'reconnecting'
          ? '⟳ Reconnecting to server…'
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
          // 720p keeps long recordings uploadable (default quality can be 4K,
          // which is hundreds of MB per minute — too big to send anywhere).
          videoQuality="720p"
          // Small stills: the live-view frames come from takePictureAsync, and
          // full-res photos would be ~1MB each — 720p keeps them ~50-100KB.
          pictureSize="1280x720"
          animateShutter={false}
          onCameraReady={handleCameraReady}
        />
        {/* App backgrounded: the camera can't run, so cover the frozen frame with
            a clear "paused" panel that reassures audio + location are still on. */}
        {cameraPaused && (
          <View style={styles.pausedCover} pointerEvents="none">
            <Ionicons name="pause-circle" size={64} color="#fff" />
            <Text style={styles.pausedTitle}>Camera paused</Text>
            <Text style={styles.pausedSub}>
              You left the app. Audio and your live location are still recording — the video picks
              back up when you return.
            </Text>
          </View>
        )}
        <SafeAreaView style={styles.cameraOverlay} pointerEvents="box-none">
          <View style={styles.recRow}>
            {isRecording && (
              <View style={styles.recBadge}>
                <View style={[styles.recDot, cameraPaused && { backgroundColor: Beacon.warn }]} />
                <Text style={styles.recLabel}>{cameraPaused ? 'AUDIO' : 'REC'}</Text>
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
            {ackByCircle && (
              <Text style={[styles.camStatusLabel, { color: Beacon.safe }]}>🟢 Someone is on their way to you</Text>
            )}
          </View>
          <View style={styles.endWrap}>
            {/* "I'm safe" is THE stop: ends the session, stops all alerts, and
                texts the circle "✅ <name> is safe." automatically. */}
            <PillButton
              title="I'm safe"
              kind={overdue ? 'primary' : 'dark'}
              onPress={handleEnd}
              style={styles.endBtn}
            />
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
        <View style={styles.hbarActions}>
          {/* Discreet Gold chip: shortcut for Gold users, quiet discovery for free users. */}
          <Pressable style={styles.gear} hitSlop={8} onPress={() => { hTap(); router.push('/(tabs)/gold'); }}>
            <Ionicons name={goldActive ? 'star' : 'star-outline'} size={17} color="#f5b942" />
          </Pressable>
          <Pressable style={styles.gear} hitSlop={8} onPress={() => { hTap(); router.push('/(tabs)/explore'); }}>
            <Ionicons name="settings-outline" size={18} color={Beacon.muted} />
          </Pressable>
        </View>
      </View>

      {/* Coverage strip */}
      <Pressable style={styles.cover} onPress={() => { hTap(); router.push('/(tabs)/contacts'); }}>
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
                  hTap();
                  setShowCheckIn(false);
                  startCheckIn(min * 60);
                }}>
                <Text style={styles.ciChipText}>{min}m</Text>
              </Pressable>
            ))}
            <Pressable style={styles.ciCancel} onPress={() => { hTap(); setShowCheckIn(false); }}>
              <Ionicons name="close" size={16} color={Beacon.muted} />
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.checkInBtn} onPress={() => { hTap(); setShowCheckIn(true); }}>
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
  hbarActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  pausedCover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6,8,12,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  pausedTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  pausedSub: { color: '#9aa4b2', fontSize: 14, lineHeight: 21, textAlign: 'center' },
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
