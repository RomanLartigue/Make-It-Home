import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader } from '@/components/beacon/kit';
import { DragBeacon } from '@/components/beacon/DragBeacon';
import { getServerUrl, getUserName, fetchWithAuth, syncCircle } from '@/utils/serverUrl';

const CIRCLE_KEY = '@makeithome_safety_circle';

type Status = 'idle' | 'sending' | 'sent' | 'error';

export default function TestAlertScreen() {
  const router = useRouter();
  const [phones, setPhones] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<{ sent: number; failed: number } | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(CIRCLE_KEY).then(raw => {
      const circle = raw ? JSON.parse(raw) : [];
      setPhones(circle.map((c: any) => c.phone).filter(Boolean));
    });
  }, []);

  const sendTest = async () => {
    if (phones.length === 0) return;
    setStatus('sending');
    try {
      await syncCircle(phones);
      const [serverUrl, name] = await Promise.all([getServerUrl(), getUserName()]);
      const res = await fetchWithAuth(`${serverUrl}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones, name }),
      });
      if (res.ok) {
        setResult(await res.json().catch(() => ({ sent: phones.length, failed: 0 })));
        setStatus('sent');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  const empty = phones.length === 0;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Test your alert" onBack={() => router.back()} />
      </View>

      <View style={styles.body}>
        {status === 'sent' ? (
          <View style={styles.center}>
            <View style={[styles.iconCircle, { backgroundColor: '#12351f', borderColor: '#1f6b40' }]}>
              <Ionicons name="checkmark" size={40} color={Beacon.safe} />
            </View>
            <Text style={styles.bigTitle}>Test sent</Text>
            <Text style={styles.centerSub}>
              {result ? `${result.sent} ${result.sent === 1 ? 'person' : 'people'} got a test text` : 'Your circle got a test text'}
              {result && result.failed > 0 ? ` · ${result.failed} couldn’t be reached` : ''}
              . It’s clearly marked as not a real emergency.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.iconCircle}>
              <Ionicons name="flask-outline" size={34} color={Beacon.beacon} />
            </View>
            <Text style={styles.bigTitle}>Send a test alert</Text>
            <Text style={styles.centerSub}>
              This texts everyone in your circle a message that says you’re testing Make It Home — it’s
              clearly marked <Text style={{ color: Beacon.text, fontWeight: '700' }}>not a real emergency</Text>.
              A good way to make sure your alerts actually reach people.
            </Text>

            {empty ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>
                  Add someone to your circle first, then come back to test.
                </Text>
              </View>
            ) : (
              <View style={styles.recips}>
                <Ionicons name="people" size={15} color={Beacon.muted} />
                <Text style={styles.recipsText}>
                  Will go to {phones.length} {phones.length === 1 ? 'person' : 'people'} in your circle
                </Text>
              </View>
            )}

            <View style={{ flex: 1 }} />

            {status === 'error' && (
              <Text style={styles.errText}>Couldn’t reach the server — check your connection and try again.</Text>
            )}
            {status === 'sending' ? (
              <View style={styles.sending}>
                <ActivityIndicator color={Beacon.beacon} />
                <Text style={styles.sendingText}>Sending test…</Text>
              </View>
            ) : (
              <DragBeacon
                icon="flask"
                idleLabel="Hold"
                idleSub="& drag out"
                armedLabel="Release"
                armedSub="to send test"
                onConfirm={sendTest}
                disabled={empty}
              />
            )}
            <Text style={styles.footHint}>Hold the beacon, drag out, then release to send a test.</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  body: { flex: 1, paddingHorizontal: 24, paddingBottom: 28, alignItems: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconCircle: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    marginBottom: 16,
  },
  bigTitle: { fontSize: 22, fontWeight: '800', color: Beacon.text, marginBottom: 8 },
  centerSub: { fontSize: 13.5, color: Beacon.muted, textAlign: 'center', lineHeight: 20, maxWidth: 320 },
  recips: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginTop: 18,
  },
  recipsText: { color: Beacon.muted, fontSize: 13, fontWeight: '600' },
  emptyCard: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 16,
    marginTop: 18,
  },
  emptyText: { color: Beacon.muted, fontSize: 13, textAlign: 'center' },
  sending: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 62 },
  sendingText: { color: Beacon.muted, fontSize: 14, fontWeight: '600' },
  errText: { color: '#f87171', fontSize: 12.5, textAlign: 'center', marginBottom: 12 },
  footHint: { color: Beacon.faint, fontSize: 11.5, textAlign: 'center', marginTop: 12 },
});
