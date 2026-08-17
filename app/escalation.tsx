import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout } from '@/components/beacon/kit';
import { ESCALATION_SCHEDULE_KEY, DEFAULT_SCHEDULE, normalizeSchedule } from '@/constants/escalation';

const CIRCLE_KEY = '@makeithome_safety_circle';

export default function EscalationScreen() {
  const router = useRouter();
  const [schedule, setSchedule] = useState<number[]>(DEFAULT_SCHEDULE);
  const [circleCount, setCircleCount] = useState(0);

  useEffect(() => {
    (async () => {
      const [rawSchedule, rawCircle] = await Promise.all([
        AsyncStorage.getItem(ESCALATION_SCHEDULE_KEY),
        AsyncStorage.getItem(CIRCLE_KEY),
      ]);
      setSchedule(normalizeSchedule(rawSchedule ? JSON.parse(rawSchedule) : null));
      setCircleCount(rawCircle ? JSON.parse(rawCircle).length : 0);
    })();
  }, []);

  // Build the visible timeline: an immediate alert, then a re-notification after
  // each scheduled wait (cumulative from go-live).
  const timeline: { label: string; at: number; first?: boolean }[] = [];
  let elapsed = 0;
  timeline.push({ label: 'You go live — everyone is alerted', at: 0, first: true });
  schedule.forEach((wait, i) => {
    elapsed += wait;
    timeline.push({ label: `Everyone is texted again (reminder ${i + 1})`, at: elapsed });
  });

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

        <Text style={styles.secLabel}>What happens if no one responds</Text>
        <View style={styles.card}>
          {timeline.map((t, i) => (
            <View key={i} style={[styles.row, i === timeline.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={styles.timeCol}>
                <Text style={[styles.timeText, t.first && { color: Beacon.beacon }]}>
                  {t.at === 0 ? 'now' : `+${t.at}m`}
                </Text>
              </View>
              <View style={styles.dotCol}>
                <View style={[styles.dot, t.first && styles.dotFirst]} />
                {i < timeline.length - 1 && <View style={styles.dotLine} />}
              </View>
              <Text style={styles.rowLabel}>{t.label}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.note}>
          The moment a responder taps “I’m on my way,” the reminders stop — no one is texted again.
        </Text>

        <View style={styles.upsell}>
          <Ionicons name="sparkles-outline" size={16} color={Beacon.amber} />
          <Text style={styles.upsellText}>
            <Text style={{ color: Beacon.text, fontWeight: '700' }}>Silver &amp; Gold: </Text>
            set your own reminder times and how many — coming with subscriptions.
          </Text>
        </View>

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

  secLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Beacon.faint,
    marginTop: 12,
    marginBottom: 8,
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
  rowLabel: { flex: 1, fontSize: 13.5, color: Beacon.text, lineHeight: 18, paddingLeft: 4 },
  note: { fontSize: 12, color: Beacon.faint, lineHeight: 17, marginTop: 10, paddingHorizontal: 2 },

  upsell: {
    flexDirection: 'row',
    gap: 9,
    alignItems: 'flex-start',
    backgroundColor: '#1e1a12',
    borderWidth: 1,
    borderColor: '#3a3016',
    borderRadius: RADIUS.card,
    padding: 13,
    marginTop: 18,
  },
  upsellText: { flex: 1, color: Beacon.muted, fontSize: 12.5, lineHeight: 18 },
});
