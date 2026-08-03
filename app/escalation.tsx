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
const ACK_KEY = '@makeithome_escalation_ack';
const WAIT_CYCLE = [2, 3, 5, 10];

// TODO: true staged escalation (alert contacts one at a time, climbing the
// ladder until someone acknowledges) needs a server-side scheduler plus an
// acknowledgement link contacts can tap. Until that ships, every alert path
// texts the whole circle at once — the settings below (order, wait, stop-on-ack)
// are stored now so they take effect the moment that feature lands.

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
      const a = await AsyncStorage.getItem(ACK_KEY);
      if (raw) setCircle(JSON.parse(raw));
      if (w) setWait(Number(w));
      if (a != null) setStopOnAck(a === 'true');
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

  const toggleAck = () => {
    setStopOnAck(prev => {
      const next = !prev;
      AsyncStorage.setItem(ACK_KEY, String(next));
      return next;
    });
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Escalation ladder" onBack={() => router.back()} />
        <Text style={styles.subttl}>
          Today, everyone in your circle is alerted at once with your location. This order sets who
          is listed first in that message. Staged escalation is coming soon.
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
                  <Text style={styles.escWhen}>{i === 0 ? 'Listed first' : `Listed #${i + 1}`}</Text>
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

        <SectionLabel>Coming soon — staged escalation</SectionLabel>
        <Card style={{ paddingVertical: 2 }}>
          <Pressable style={styles.ruleRow} onPress={cycleWait}>
            <Text style={styles.ruleLabel}>Wait between people</Text>
            <Text style={styles.ruleVal}>{wait} min ›</Text>
          </Pressable>
          <View style={[styles.ruleRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.ruleLabel}>“On my way” stops the ladder</Text>
            <Toggle value={stopOnAck} onToggle={toggleAck} />
          </View>
        </Card>
        <Text style={styles.note}>
          These settings are saved now and take effect when staged escalation ships — climbing the
          ladder one person at a time and letting a responder stop it.
        </Text>

        <Callout>
          For now, alerting everyone at once is the most reliable way to reach someone fast. We&apos;ll
          add climb-the-ladder timing and shared “on my way” status in a later update.
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
  note: { fontSize: 11.5, color: Beacon.faint, lineHeight: 17, marginTop: 8, paddingHorizontal: 2 },
});
