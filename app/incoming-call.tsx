import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Vibration, Platform, AppState } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import Ionicons from '@expo/vector-icons/Ionicons';

import { initials } from '@/constants/beacon';
import { ringtoneSource } from '@/constants/ringtones';
import { createRingtonePlayer, RingtonePlayer } from '@/utils/ringtonePlayer';

// A convincing fake incoming call the user can trigger to create a natural
// reason to leave a situation. Full-screen, outside the tab bar. Styled to match
// a real iOS call. Rings (looping tone + vibration) until answered or declined;
// answering shows a running call timer.
//
// NOTE: expo-audio is loaded lazily via utils/ringtonePlayer, NOT imported at
// the top of this file. expo-router evaluates every route at launch, and
// expo-audio touches its native module at import time — importing it here put
// audio initialization on the app's launch path and crashed the Release build.
const VIBRATION_PATTERN = Platform.OS === 'ios' ? [0, 1000, 2000] : [0, 700, 1000, 700, 2000];

export default function IncomingCallScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ caller?: string; sub?: string; ringtone?: string }>();
  const caller = (typeof params.caller === 'string' && params.caller.trim()) || 'Mom';
  const sub = (typeof params.sub === 'string' && params.sub.trim()) || 'mobile';

  const [answered, setAnswered] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const playerRef = useRef<RingtonePlayer | null>(null);
  const ringingRef = useRef(true);

  // Start ringing on mount. Audio is created here (lazily), never at import.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await createRingtonePlayer(ringtoneSource(params.ringtone));
        if (cancelled) {
          p.release();
          return;
        }
        playerRef.current = p;
        p.playLooping();
      } catch {
        // Audio unavailable — vibration still runs, screen still shows.
      }
    })();
    try {
      Vibration.vibrate(VIBRATION_PATTERN, true);
    } catch {}
    return () => {
      cancelled = true;
      stopRinging();
      playerRef.current?.release();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the app is backgrounded while ringing, stop buzzing so it doesn't rattle
  // in a pocket forever; the screen stays so it's there when they return.
  useEffect(() => {
    const s = AppState.addEventListener('change', st => {
      if (st !== 'active' && ringingRef.current) {
        try { Vibration.cancel(); } catch {}
      }
    });
    return () => s.remove();
  }, []);

  function stopRinging() {
    ringingRef.current = false;
    try { Vibration.cancel(); } catch {}
    try { playerRef.current?.stop(); } catch {}
  }

  useEffect(() => {
    if (!answered) return;
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [answered]);

  const answer = () => {
    stopRinging();
    setAnswered(true);
  };

  const end = () => {
    stopRinging();
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <View style={styles.root}>
      <StatusBar hidden />

      {/* Caller identity — matches iOS: big name, small gray subtitle, no app label */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(caller)}</Text>
        </View>
        <Text style={styles.caller}>{caller}</Text>
        <Text style={styles.sub}>{answered ? clock : sub}</Text>
      </View>

      {answered ? (
        <View style={styles.activeBottom}>
          {/* In-call control grid */}
          <View style={styles.grid}>
            {[
              { icon: 'mic-off', label: 'mute' },
              { icon: 'keypad', label: 'keypad' },
              { icon: 'volume-high', label: 'audio' },
              { icon: 'add', label: 'add call' },
              { icon: 'videocam', label: 'FaceTime' },
              { icon: 'person', label: 'contacts' },
            ].map(c => (
              <View key={c.label} style={styles.gridItem}>
                <View style={styles.ctrl}>
                  <Ionicons name={c.icon as any} size={28} color="#fff" />
                </View>
                <Text style={styles.ctrlLabel}>{c.label}</Text>
              </View>
            ))}
          </View>
          <View style={styles.endRow}>
            <View style={styles.actionCol}>
              <Pressable style={[styles.round, styles.decline]} onPress={end} hitSlop={8}>
                <Ionicons name="call" size={32} color="#fff" style={styles.phoneDown} />
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.ringBottom}>
          {/* Secondary actions, like iOS */}
          <View style={styles.secondaryRow}>
            <View style={styles.actionCol}>
              <Pressable style={styles.small} onPress={end} hitSlop={8}>
                <Ionicons name="alarm" size={26} color="#fff" />
              </Pressable>
              <Text style={styles.smallLabel}>Remind Me</Text>
            </View>
            <View style={styles.actionCol}>
              <Pressable style={styles.small} onPress={end} hitSlop={8}>
                <Ionicons name="chatbubble" size={24} color="#fff" />
              </Pressable>
              <Text style={styles.smallLabel}>Message</Text>
            </View>
          </View>

          {/* Decline / Accept */}
          <View style={styles.answerRow}>
            <View style={styles.actionCol}>
              <Pressable style={[styles.round, styles.decline]} onPress={end} hitSlop={8}>
                <Ionicons name="call" size={34} color="#fff" style={styles.phoneDown} />
              </Pressable>
              <Text style={styles.actLabel}>Decline</Text>
            </View>
            <View style={styles.actionCol}>
              <Pressable style={[styles.round, styles.accept]} onPress={answer} hitSlop={8}>
                <Ionicons name="call" size={34} color="#fff" />
              </Pressable>
              <Text style={styles.actLabel}>Accept</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#1c1c1e',
    paddingHorizontal: 40,
    paddingTop: 84,
    paddingBottom: 52,
    justifyContent: 'space-between',
  },
  header: { alignItems: 'center', gap: 8 },
  avatar: {
    width: 108,
    height: 108,
    borderRadius: 54,
    backgroundColor: '#3a3a3c',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  avatarText: { color: '#fff', fontSize: 42, fontWeight: '400' },
  caller: { color: '#fff', fontSize: 38, fontWeight: '400', letterSpacing: 0.2 },
  sub: { color: '#c7c7cc', fontSize: 17, fontVariant: ['tabular-nums'] },

  // Ringing bottom
  ringBottom: { gap: 34 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 6 },
  answerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 },

  // Active bottom
  activeBottom: { gap: 30 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 22 },
  gridItem: { width: '33.33%', alignItems: 'center', gap: 8 },
  ctrl: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlLabel: { color: '#fff', fontSize: 13 },
  endRow: { alignItems: 'center', marginTop: 4 },

  actionCol: { alignItems: 'center', gap: 11 },
  small: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallLabel: { color: '#fff', fontSize: 13 },

  round: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  accept: { backgroundColor: '#30d158' },
  decline: { backgroundColor: '#ff3b30' },
  phoneDown: { transform: [{ rotate: '135deg' }] },
  actLabel: { color: '#fff', fontSize: 15 },
});
