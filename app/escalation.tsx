import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Beacon } from '@/constants/beacon';
import { DetailHeader, SectionLabel, Callout, Toggle, Card } from '@/components/beacon/kit';

const STORAGE_KEY = '@makeithome_safety_circle';
const WAIT_KEY = '@makeithome_escalation_wait';
const WAIT_CYCLE = [2, 3, 5, 10];

interface SafetyContact {
  id: string;
  name: string;
  phone: string;
}

export default function EscalationScreen() {
  const router = useRouter();
  const [circle, setCircle] = useState<SafetyContact[]>([]);
  const [wait, setWait] = useState(3);
  const [stopOnAck, setStopOnAck] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const w = await AsyncStorage.getItem(WAIT_KEY);
      if (raw) setCircle(JSON.parse(raw));
      if (w) setWait(Number(w));
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (loaded) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(circle));
  }, [circle, loaded]);

  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= circle.length) return;
    setCircle(prev => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const cycleWait = () => {
    const next = WAIT_CYCLE[(WAIT_CYCLE.indexOf(wait) + 1) % WAIT_CYCLE.length];
    setWait(next);
    AsyncStorage.setItem(WAIT_KEY, String(next));
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Escalation ladder" onBack={() => router.back()} />
        <Text style={styles.subttl}>
          We climb the ladder until someone responds. Use the arrows to set who&apos;s alerted first.
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}>
        {circle.length === 0 ? (
          <Card style={{ paddingVertical: 18, alignItems: 'center' }}>
            <Text style={{ color: Beacon.muted, fontSize: 13, textAlign: 'center' }}>
              No one in your circle yet.{' '}
              <Text style={{ color: Beacon.beacon, fontWeight: '700' }} onPress={() => router.back()}>
                Add someone
              </Text>{' '}
              to build your ladder.
            </Text>
          </Card>
        ) : (
          <Card style={{ paddingVertical: 2 }}>
            {circle.map((c, i) => (
              <View
                key={c.id}
                style={[styles.escRow, i === circle.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={[styles.rank, i === 0 && styles.rankFirst]}>
                  <Text style={[styles.rankText, i === 0 && { color: Beacon.beacon }]}>{i + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.escName}>{c.name}</Text>
                  <Text style={styles.escWhen}>{i === 0 ? 'Alerted first' : `+${i * wait} min`}</Text>
                </View>
                <View style={styles.moveBtns}>
                  <Pressable
                    onPress={() => move(i, -1)}
                    disabled={i === 0}
                    hitSlop={6}
                    style={[styles.moveBtn, i === 0 && { opacity: 0.3 }]}>
                    <Ionicons name="chevron-up" size={18} color={Beacon.text} />
                  </Pressable>
                  <Pressable
                    onPress={() => move(i, 1)}
                    disabled={i === circle.length - 1}
                    hitSlop={6}
                    style={[styles.moveBtn, i === circle.length - 1 && { opacity: 0.3 }]}>
                    <Ionicons name="chevron-down" size={18} color={Beacon.text} />
                  </Pressable>
                </View>
              </View>
            ))}
          </Card>
        )}

        <SectionLabel>Rules</SectionLabel>
        <Card style={{ paddingVertical: 2 }}>
          <Pressable style={styles.ruleRow} onPress={cycleWait}>
            <Text style={styles.ruleLabel}>Wait between people</Text>
            <Text style={styles.ruleVal}>{wait} min ›</Text>
          </Pressable>
          <View style={[styles.ruleRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.ruleLabel}>“On my way” stops the ladder</Text>
            <Toggle value={stopOnAck} onToggle={() => setStopOnAck(v => !v)} />
          </View>
        </Card>

        <Callout>
          Responders see each other — “Alex is on the way” — so no one double-panics and help
          isn&apos;t duplicated.
        </Callout>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  subttl: { color: Beacon.muted, fontSize: 12.5, marginTop: 10, marginBottom: 12, lineHeight: 18 },
  escRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  rank: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankFirst: { borderColor: Beacon.beacon },
  rankText: { fontSize: 11, fontWeight: '700', color: Beacon.muted },
  escName: { fontSize: 14, fontWeight: '600', color: Beacon.text },
  escWhen: { fontSize: 11, color: Beacon.faint, marginTop: 1 },
  moveBtns: { flexDirection: 'row', gap: 4 },
  moveBtn: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ruleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  ruleLabel: { fontSize: 14, color: Beacon.text, flexShrink: 1, paddingRight: 10 },
  ruleVal: { fontSize: 13, color: Beacon.muted },
});
