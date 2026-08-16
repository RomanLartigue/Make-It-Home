import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Vibration, Platform, AppState } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';

import { Beacon, initials } from '@/constants/beacon';

// A convincing fake incoming call the user can trigger to create a reason to
// leave a situation. Full-screen, outside the tab bar. Rings (looping tone +
// vibration) until answered or declined; answering shows a running call timer.
const RING = require('../assets/sounds/ringtone.wav');
const VIBRATION_PATTERN = Platform.OS === 'ios' ? [0, 1000, 2000] : [0, 700, 1000, 700, 2000];

export default function IncomingCallScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ caller?: string; sub?: string }>();
  const caller = (typeof params.caller === 'string' && params.caller.trim()) || 'Mom';
  const sub = (typeof params.sub === 'string' && params.sub.trim()) || 'mobile';

  const [answered, setAnswered] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const player = useAudioPlayer(RING);
  const ringingRef = useRef(true);

  // Start ringing on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
      } catch {}
      if (cancelled) return;
      try {
        player.loop = true;
        player.volume = 1.0;
        player.play();
      } catch {}
    })();
    try {
      Vibration.vibrate(VIBRATION_PATTERN, true);
    } catch {}
    return () => {
      cancelled = true;
      stopRinging();
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
    try { player.pause(); } catch {}
  }

  // Call timer once answered.
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
      {/* Caller identity */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(caller)}</Text>
        </View>
        <Text style={styles.caller}>{caller}</Text>
        <Text style={styles.sub}>{answered ? clock : `${sub} · Make It Home Audio`}</Text>
      </View>

      {answered ? (
        <>
          {/* Decorative in-call controls */}
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
                  <Ionicons name={c.icon as any} size={26} color="#fff" />
                </View>
                <Text style={styles.ctrlLabel}>{c.label}</Text>
              </View>
            ))}
          </View>
          <View style={styles.endWrap}>
            <Pressable style={[styles.round, styles.decline]} onPress={end} hitSlop={8}>
              <Ionicons name="call" size={32} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
            </Pressable>
            <Text style={styles.actLabel}>end</Text>
          </View>
        </>
      ) : (
        <View style={styles.answerRow}>
          <View style={styles.answerCol}>
            <Pressable style={[styles.round, styles.decline]} onPress={end} hitSlop={8}>
              <Ionicons name="call" size={34} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
            </Pressable>
            <Text style={styles.actLabel}>Decline</Text>
          </View>
          <View style={styles.answerCol}>
            <Pressable style={[styles.round, styles.accept]} onPress={answer} hitSlop={8}>
              <Ionicons name="call" size={34} color="#fff" />
            </Pressable>
            <Text style={styles.actLabel}>Accept</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0d12',
    paddingHorizontal: 28,
    paddingTop: 96,
    paddingBottom: 56,
    justifyContent: 'space-between',
  },
  header: { alignItems: 'center', gap: 10 },
  avatar: {
    width: 116,
    height: 116,
    borderRadius: 58,
    backgroundColor: '#2a3441',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: { color: '#fff', fontSize: 40, fontWeight: '600' },
  caller: { color: '#fff', fontSize: 34, fontWeight: '600', letterSpacing: 0.3 },
  sub: { color: '#aab4c2', fontSize: 15, fontVariant: ['tabular-nums'] },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 26, marginVertical: 8 },
  gridItem: { width: 84, alignItems: 'center', gap: 7 },
  ctrl: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlLabel: { color: '#cfd6e0', fontSize: 12 },

  answerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12 },
  answerCol: { alignItems: 'center', gap: 12 },
  endWrap: { alignItems: 'center', gap: 12 },

  round: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center' },
  accept: { backgroundColor: '#34c759' },
  decline: { backgroundColor: '#ff3b30' },
  actLabel: { color: '#fff', fontSize: 14 },
});
