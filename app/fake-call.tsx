import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout, PillButton } from '@/components/beacon/kit';
import { RINGTONES, DEFAULT_RINGTONE, ringtoneSource, RingtoneId } from '@/constants/ringtones';
// expo-audio is loaded lazily (see utils/ringtonePlayer) — importing it at the
// top of a route file puts audio init on the app launch path and crashed the
// Release build.
import { createRingtonePlayer, RingtonePlayer } from '@/utils/ringtonePlayer';

const CALLER_KEY = '@makeithome_fakecall_name';
const RINGTONE_KEY = '@makeithome_fakecall_ringtone';
const DELAYS = [
  { label: 'Now', seconds: 0 },
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '1 min', seconds: 60 },
];

export default function FakeCallScreen() {
  const router = useRouter();
  const [caller, setCaller] = useState('Mom');
  const [delay, setDelay] = useState(0);
  const [ringtone, setRingtone] = useState<RingtoneId>(DEFAULT_RINGTONE);
  const [countdown, setCountdown] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // A single reusable player for previewing ringtones as the user taps them.
  // Created lazily on first preview so expo-audio never loads at app launch.
  const previewRef = useRef<RingtonePlayer | null>(null);
  const previewLoading = useRef<Promise<RingtonePlayer> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(CALLER_KEY).then(v => {
      if (v) setCaller(v);
    });
    AsyncStorage.getItem(RINGTONE_KEY).then(v => {
      if (v && RINGTONES.some(r => r.id === v)) setRingtone(v as RingtoneId);
    });
    return () => {
      if (timer.current) clearInterval(timer.current);
      previewRef.current?.release();
      previewRef.current = null;
    };
  }, []);

  const pickRingtone = async (id: RingtoneId) => {
    setRingtone(id);
    AsyncStorage.setItem(RINGTONE_KEY, id).catch(() => {});
    try {
      if (!previewRef.current) {
        if (!previewLoading.current) {
          previewLoading.current = createRingtonePlayer(ringtoneSource(id));
        }
        previewRef.current = await previewLoading.current;
      } else {
        previewRef.current.replace(ringtoneSource(id));
      }
      previewRef.current.playOnce();
    } catch {
      // preview is best-effort
    }
  };

  const ring = () => {
    const name = caller.trim() || 'Mom';
    AsyncStorage.setItem(CALLER_KEY, name).catch(() => {});
    try { previewRef.current?.stop(); } catch {}
    router.push({ pathname: '/incoming-call', params: { caller: name, ringtone } });
  };

  const start = () => {
    if (delay === 0) {
      ring();
      return;
    }
    setCountdown(delay);
    timer.current = setInterval(() => {
      setCountdown(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (timer.current) clearInterval(timer.current);
          setCountdown(null);
          ring();
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const cancel = () => {
    if (timer.current) clearInterval(timer.current);
    setCountdown(null);
  };

  // Countdown state — the call is scheduled and armed.
  if (countdown !== null) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <DetailHeader title="Fake Call" onBack={cancel} />
        <View style={styles.countWrap}>
          <Text style={styles.countLabel}>Ringing in</Text>
          <Text style={styles.countNum}>{countdown}</Text>
          <Text style={styles.countHint}>
            Keep the app open and put your phone away. {caller.trim() || 'Mom'} will call any second.
          </Text>
          <PillButton title="Cancel" kind="dark" onPress={cancel} style={{ marginTop: 28, minWidth: 160 }} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <DetailHeader title="Fake Call" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Callout>
          Trigger a realistic incoming call to give yourself a natural reason to step away from an
          uncomfortable or unsafe situation. Nothing is sent to anyone — it&apos;s only on your phone.
        </Callout>

        <Text style={styles.label}>Who&apos;s calling?</Text>
        <TextInput
          style={styles.input}
          value={caller}
          onChangeText={setCaller}
          placeholder="e.g. Mom"
          placeholderTextColor={Beacon.faint}
          maxLength={30}
          returnKeyType="done"
        />

        <Text style={styles.label}>Ringtone</Text>
        <View style={styles.ringtoneList}>
          {RINGTONES.map(r => {
            const on = ringtone === r.id;
            return (
              <Pressable
                key={r.id}
                onPress={() => pickRingtone(r.id)}
                style={[styles.ringRow, on && styles.ringRowOn]}
              >
                <Ionicons
                  name={on ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={on ? Beacon.beacon : Beacon.faint}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.ringName}>{r.label}</Text>
                  <Text style={styles.ringHint}>{r.hint}</Text>
                </View>
                <Ionicons name="volume-medium-outline" size={18} color={Beacon.muted} />
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hintLine}>
          Ringtone sound is temporarily off in this test build — the call still rings with vibration.
          Your choice is saved for when sound returns.
        </Text>

        <Text style={styles.label}>When?</Text>
        <View style={styles.chips}>
          {DELAYS.map(d => {
            const on = delay === d.seconds;
            return (
              <Pressable
                key={d.label}
                onPress={() => setDelay(d.seconds)}
                style={[styles.chip, on && styles.chipOn]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{d.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <PillButton
          title={delay === 0 ? 'Call me now' : `Call me in ${DELAYS.find(d => d.seconds === delay)?.label}`}
          onPress={start}
          style={{ marginTop: 28 }}
        />
        <Text style={styles.tip}>
          Tip: pick a delay, then pocket your phone — the call rings on its own so it looks like it
          came in naturally.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night, paddingHorizontal: 18 },
  body: { paddingTop: 8, paddingBottom: 40, gap: 4 },
  label: { color: Beacon.muted, fontSize: 12.5, fontWeight: '700', marginTop: 22, marginBottom: 10, letterSpacing: 0.3 },
  input: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.field,
    color: Beacon.text,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  ringtoneList: { gap: 8 },
  ringRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.field,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  ringRowOn: { borderColor: Beacon.beacon, backgroundColor: Beacon.surface2 },
  ringName: { color: Beacon.text, fontSize: 15.5, fontWeight: '600' },
  ringHint: { color: Beacon.muted, fontSize: 12.5, marginTop: 1 },
  hintLine: { color: Beacon.faint, fontSize: 12, marginTop: 8, lineHeight: 17 },
  chips: { flexDirection: 'row', gap: 10 },
  chip: {
    flex: 1,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.pill,
    paddingVertical: 12,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: Beacon.surface2, borderColor: Beacon.beacon },
  chipText: { color: Beacon.muted, fontSize: 14, fontWeight: '600' },
  chipTextOn: { color: Beacon.text },
  tip: { color: Beacon.faint, fontSize: 12.5, lineHeight: 18, marginTop: 18, textAlign: 'center' },

  countWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingBottom: 60 },
  countLabel: { color: Beacon.muted, fontSize: 15, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase' },
  countNum: { color: Beacon.beacon, fontSize: 96, fontWeight: '800', fontVariant: ['tabular-nums'], marginVertical: 4 },
  countHint: { color: Beacon.muted, fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 300 },
});
