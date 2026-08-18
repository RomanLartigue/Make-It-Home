import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout, PillButton } from '@/components/beacon/kit';
import { GoldUpsell, GoldBadge, GOLD } from '@/components/beacon/GoldGate';
import { useGold } from '@/utils/gold';
import {
  ESCALATION_SCHEDULE_KEY,
  DEFAULT_SCHEDULE,
  MAX_FREE_ROUNDS,
  normalizeSchedule,
} from '@/constants/escalation';

const CIRCLE_KEY = '@makeithome_safety_circle';
const MAX_GOLD_ROUNDS = 8;
const MAX_WAIT_MIN = 120;

export default function EscalationScreen() {
  const router = useRouter();
  const gold = useGold();
  const [schedule, setSchedule] = useState<number[]>(DEFAULT_SCHEDULE);
  // Text drafts mirror the schedule so typing feels natural (can be empty mid-edit).
  const [drafts, setDrafts] = useState<string[]>(DEFAULT_SCHEDULE.map(String));
  const [circleCount, setCircleCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [rawSchedule, rawCircle] = await Promise.all([
        AsyncStorage.getItem(ESCALATION_SCHEDULE_KEY),
        AsyncStorage.getItem(CIRCLE_KEY),
      ]);
      const sched = normalizeSchedule(rawSchedule ? JSON.parse(rawSchedule) : null);
      setSchedule(sched);
      setDrafts(sched.map(String));
      setCircleCount(rawCircle ? JSON.parse(rawCircle).length : 0);
      setLoaded(true);
    })();
  }, []);

  // Free users always run the fixed default schedule, even if a stale custom
  // one is on disk (e.g. Gold lapsed). Gold users run whatever they've set.
  const effective = gold ? schedule : DEFAULT_SCHEDULE;

  const persist = (next: number[]) => {
    setSchedule(next);
    AsyncStorage.setItem(ESCALATION_SCHEDULE_KEY, JSON.stringify(next)).catch(() => {});
  };
  // Live-edit a reminder's minutes: keep only digits in the draft.
  const editDraft = (i: number, text: string) =>
    setDrafts(d => d.map((v, idx) => (idx === i ? text.replace(/[^0-9]/g, '').slice(0, 3) : v)));
  // Commit on blur: clamp 1..120; empty/zero reverts to the current value.
  const commitDraft = (i: number) => {
    const parsed = parseInt(drafts[i], 10);
    const val = Number.isFinite(parsed) && parsed > 0 ? Math.min(MAX_WAIT_MIN, parsed) : schedule[i];
    persist(schedule.map((w, idx) => (idx === i ? val : w)));
    setDrafts(d => d.map((v, idx) => (idx === i ? String(val) : v)));
  };
  const addRound = () => {
    if (schedule.length >= MAX_GOLD_ROUNDS) return;
    const val = schedule[schedule.length - 1] ?? 5;
    persist([...schedule, val]);
    setDrafts(d => [...d, String(val)]);
  };
  const removeRound = (i: number) => {
    if (schedule.length <= 1) return;
    persist(schedule.filter((_, idx) => idx !== i));
    setDrafts(d => d.filter((_, idx) => idx !== i));
  };
  const resetDefault = () => {
    persist(DEFAULT_SCHEDULE);
    setDrafts(DEFAULT_SCHEDULE.map(String));
  };

  // Timeline: immediate alert, then a reminder after each wait (cumulative).
  const timeline: { label: string; at: number; first?: boolean; idx?: number }[] = [
    { label: 'You go live — everyone is alerted', at: 0, first: true },
  ];
  let elapsed = 0;
  effective.forEach((wait, i) => {
    elapsed += wait;
    timeline.push({ label: `Everyone is texted again (reminder ${i + 1})`, at: elapsed, idx: i });
  });

  if (!loaded) return <SafeAreaView style={styles.root} edges={['top']} />;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Escalation" onBack={() => router.back()} />
        <Text style={styles.subttl}>
          If no one taps “I’m on my way,” Make It Home keeps texting your whole circle on a schedule
          until someone responds — so a missed message doesn’t mean missed help.
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 44 }}>
        {circleCount === 0 && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              No one in your circle yet.{' '}
              <Text style={styles.link} onPress={() => router.push('/(tabs)/contacts')}>
                Add someone
              </Text>{' '}
              so these alerts have somewhere to go.
            </Text>
          </View>
        )}

        <View style={styles.secRow}>
          <Text style={styles.secLabel}>What happens if no one responds</Text>
          {gold && <GoldBadge />}
        </View>
        <View style={styles.card}>
          {timeline.map((t, i) => (
            <View key={i} style={[styles.row, i === timeline.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={styles.timeCol}>
                <Text style={[styles.timeText, t.first && { color: Beacon.beacon }]}>
                  {t.at === 0 ? 'now' : `+${t.at}m`}
                </Text>
              </View>
              <View style={styles.dotCol}>
                <View style={[styles.dot, t.first && styles.dotFirst, gold && !t.first && { backgroundColor: GOLD }]} />
                {i < timeline.length - 1 && <View style={styles.dotLine} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowLabel}>{t.label}</Text>
                {gold && t.idx !== undefined && (
                  <View style={styles.editRow}>
                    <View style={styles.waitPill}>
                      <Ionicons name="time-outline" size={13} color={Beacon.muted} />
                      <TextInput
                        style={styles.waitInput}
                        value={drafts[t.idx!]}
                        onChangeText={text => editDraft(t.idx!, text)}
                        onEndEditing={() => commitDraft(t.idx!)}
                        onBlur={() => commitDraft(t.idx!)}
                        keyboardType="number-pad"
                        returnKeyType="done"
                        maxLength={3}
                        selectTextOnFocus
                      />
                      <Text style={styles.waitSuffix}>min after the previous text</Text>
                    </View>
                    {schedule.length > 1 && (
                      <Pressable onPress={() => removeRound(t.idx!)} hitSlop={8} style={styles.trash}>
                        <Ionicons name="trash-outline" size={15} color={Beacon.faint} />
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
        <Text style={styles.note}>
          The moment a responder taps “I’m on my way,” the reminders stop — no one is texted again.
        </Text>

        {gold ? (
          <View style={styles.goldControls}>
            <PillButton
              title={schedule.length >= MAX_GOLD_ROUNDS ? `Max ${MAX_GOLD_ROUNDS} reminders` : '+ Add another reminder'}
              kind="dark"
              onPress={addRound}
              disabled={schedule.length >= MAX_GOLD_ROUNDS}
              style={{ flex: 1 }}
            />
            <Pressable style={styles.resetBtn} onPress={resetDefault} hitSlop={6}>
              <Ionicons name="refresh" size={16} color={Beacon.muted} />
              <Text style={styles.resetText}>Default</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ marginTop: 18 }}>
            <GoldUpsell
              title="Set your own timing"
              body={`Free uses a fixed schedule: another text after ${DEFAULT_SCHEDULE.join(', then ')} minutes (${MAX_FREE_ROUNDS} reminders). With Gold you choose exactly when your circle is re-texted, and how many times.`}
            />
          </View>
        )}

        <Callout>
          Reminders only ever go to people already in your safety circle, and always include your
          live location.
        </Callout>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  subttl: { color: Beacon.muted, fontSize: 12.5, marginTop: 10, marginBottom: 14, lineHeight: 18 },
  link: { color: Beacon.beacon, fontWeight: '700' },

  emptyCard: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    paddingVertical: 16,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 6,
  },
  emptyText: { color: Beacon.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },

  secRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 8 },
  secLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Beacon.faint,
  },
  card: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    paddingHorizontal: 14,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Beacon.line },
  timeCol: { width: 46 },
  timeText: { fontSize: 13, fontWeight: '700', color: Beacon.muted, fontVariant: ['tabular-nums'] },
  dotCol: { width: 22, alignItems: 'center', alignSelf: 'stretch' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Beacon.faint, marginTop: 3 },
  dotFirst: { backgroundColor: Beacon.beacon },
  dotLine: { width: 2, flex: 1, backgroundColor: Beacon.line, marginTop: 2 },
  rowLabel: { fontSize: 13.5, color: Beacon.text, lineHeight: 18, paddingLeft: 4 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingLeft: 4 },
  waitPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: '#4a3c14',
    borderRadius: RADIUS.pill,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  waitInput: {
    minWidth: 34,
    color: Beacon.text,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    paddingVertical: 0,
    textAlign: 'center',
    backgroundColor: Beacon.night,
    borderWidth: 1,
    borderColor: GOLD,
    borderRadius: 8,
    paddingHorizontal: 4,
  },
  waitSuffix: { flex: 1, color: Beacon.muted, fontSize: 12 },
  trash: { padding: 4 },
  note: { fontSize: 12, color: Beacon.faint, lineHeight: 17, marginTop: 10, paddingHorizontal: 2 },

  goldControls: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 999,
  },
  resetText: { color: Beacon.muted, fontSize: 12.5, fontWeight: '600' },
});
