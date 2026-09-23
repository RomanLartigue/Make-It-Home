import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getServerUrl, fetchWithAuth } from '@/utils/serverUrl';
import { Beacon, AVATAR_COLORS, initials } from '@/constants/beacon';
import { Card, DetailHeader } from '@/components/beacon/kit';

// "Whose circles am I in?" — the mirror of the Safety circle screen. The
// server answers for this device's OWN registered number (entered during
// onboarding), listing the people who added it to their circle.

interface CircleEntry {
  name: string;
}

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function CirclesScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [hasPhone, setHasPhone] = useState(true);
  const [circles, setCircles] = useState<CircleEntry[]>([]);
  const [error, setError] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        setLoading(true);
        setError(false);
        try {
          const serverUrl = await getServerUrl();
          const res = await fetchWithAuth(`${serverUrl}/circles/mine`);
          const j = res.ok ? await res.json().catch(() => null) : null;
          if (!alive) return;
          if (!j) {
            setError(true);
          } else {
            setHasPhone(!!j.phone);
            setCircles(Array.isArray(j.circles) ? j.circles.filter((c: any) => c?.name) : []);
          }
        } catch {
          if (alive) setError(true);
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Circles you're in" onBack={() => router.back()} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.sub}>
          The people who added you to their safety circle — when they start a safety session,
          you&apos;re one of the people watching over them.
        </Text>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={Beacon.beacon} />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Ionicons name="cloud-offline-outline" size={40} color={Beacon.faint} />
            <Text style={styles.emptyText}>Couldn&apos;t reach the server — try again in a moment.</Text>
          </View>
        ) : !hasPhone ? (
          <View style={styles.center}>
            <Ionicons name="call-outline" size={40} color={Beacon.faint} />
            <Text style={styles.emptyText}>
              Make It Home doesn&apos;t know your number yet, so it can&apos;t match you to circles.
              Your number is added during setup — it&apos;s how alerts reach you as notifications too.
            </Text>
          </View>
        ) : circles.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="people-outline" size={40} color={Beacon.faint} />
            <Text style={styles.emptyText}>
              No one yet. When someone adds your number to their safety circle, they&apos;ll show up
              here.
            </Text>
          </View>
        ) : (
          circles.map((c, i) => (
            <Card key={`${c.name}-${i}`} style={styles.row}>
              <View style={[styles.avatar, { backgroundColor: avatarColor(c.name) }]}>
                <Text style={styles.avatarText}>{initials(c.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{c.name}&apos;s circle</Text>
                <Text style={styles.rowSub}>You&apos;re alerted when they need someone.</Text>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  scroll: { paddingHorizontal: 20, paddingBottom: 30, gap: 8 },
  sub: { fontSize: 12.5, color: Beacon.muted, lineHeight: 18, marginBottom: 12 },
  center: { alignItems: 'center', gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  emptyText: { color: Beacon.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  rowName: { fontSize: 14, fontWeight: '700', color: Beacon.text },
  rowSub: { fontSize: 11.5, color: Beacon.muted, marginTop: 1 },
});
