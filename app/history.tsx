import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert, ActivityIndicator, Linking, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout } from '@/components/beacon/kit';
import { GoldUpsell, GoldBadge } from '@/components/beacon/GoldGate';
import { useGold } from '@/utils/gold';
import { getServerUrl, fetchWithAuth } from '@/utils/serverUrl';

interface HistoryItem {
  id: string;
  sessionId: string | null;
  createdAt: number;
  expiresAt: number;
  sizeBytes: number | null;
  mediaUrl: string;
  latitude: number | null;
  longitude: number | null;
  durationSec: number | null;
}

function fmtDate(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtSize(b: number | null) {
  if (!b) return '';
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
}
function daysLeft(expiresAt: number) {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000));
}

export default function HistoryScreen() {
  const router = useRouter();
  const gold = useGold();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const serverUrl = await getServerUrl();
      const res = await fetchWithAuth(`${serverUrl}/history`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (e: any) {
      setError('Couldn’t load your history — check your connection.');
      setItems(prev => prev ?? []);
    }
  }, []);

  useEffect(() => {
    if (gold) load();
  }, [gold, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const remove = (item: HistoryItem) => {
    Alert.alert('Delete recording?', 'This permanently removes it from your cloud history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const serverUrl = await getServerUrl();
            const res = await fetchWithAuth(`${serverUrl}/history/delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id }),
            });
            if (res.ok) setItems(prev => (prev ?? []).filter(i => i.id !== item.id));
            else Alert.alert('Couldn’t delete', 'Please try again.');
          } catch {
            Alert.alert('Couldn’t delete', 'Please try again.');
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Recording history" onBack={() => router.back()} />
      </View>

      {!gold ? (
        <ScrollView contentContainerStyle={styles.body}>
          <GoldUpsell
            title="Cloud recording history"
            body="Free keeps each recording on your phone plus a 24-hour download link. With Gold, every session’s recording is kept safely in the cloud for 90 days — view or download it any time, from any device, and delete it whenever you like."
          />
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Beacon.muted} />}
        >
          <View style={styles.secRow}>
            <Text style={styles.secLabel}>Kept for 90 days</Text>
            <GoldBadge />
          </View>

          {items === null ? (
            <View style={styles.center}>
              <ActivityIndicator color={Beacon.muted} />
            </View>
          ) : items.length === 0 ? (
            <View style={styles.emptyCard}>
              <Ionicons name="cloud-outline" size={28} color={Beacon.faint} />
              <Text style={styles.emptyTitle}>No recordings yet</Text>
              <Text style={styles.emptyText}>
                Recordings from your sessions will appear here automatically and stay for 90 days.
              </Text>
            </View>
          ) : (
            items.map(item => (
              <View key={item.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <View style={styles.thumb}>
                    <Ionicons name="videocam" size={18} color={Beacon.beacon} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle}>{fmtDate(item.createdAt)}</Text>
                    <Text style={styles.cardMeta}>
                      {item.durationSec ? `${Math.round(item.durationSec / 60)} min · ` : ''}
                      {fmtSize(item.sizeBytes)}{fmtSize(item.sizeBytes) ? ' · ' : ''}
                      {daysLeft(item.expiresAt)}d left
                    </Text>
                  </View>
                </View>
                <View style={styles.actions}>
                  <Pressable style={styles.action} onPress={() => Linking.openURL(item.mediaUrl)}>
                    <Ionicons name="download-outline" size={16} color={Beacon.text} />
                    <Text style={styles.actionText}>Download</Text>
                  </Pressable>
                  {item.latitude != null && item.longitude != null && (
                    <Pressable
                      style={styles.action}
                      onPress={() => Linking.openURL(`https://maps.google.com/?q=${item.latitude},${item.longitude}`)}
                    >
                      <Ionicons name="location-outline" size={16} color={Beacon.text} />
                      <Text style={styles.actionText}>Where</Text>
                    </Pressable>
                  )}
                  <Pressable style={[styles.action, styles.actionDanger]} onPress={() => remove(item)}>
                    <Ionicons name="trash-outline" size={16} color="#f87171" />
                    <Text style={[styles.actionText, { color: '#f87171' }]}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            ))
          )}

          {error && <Text style={styles.err}>{error}</Text>}

          <Callout>
            Your recordings are private to this device and deleted automatically after 90 days — or
            sooner, whenever you tap Delete.
          </Callout>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  body: { paddingHorizontal: 20, paddingBottom: 44, paddingTop: 6 },
  secRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  secLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', color: Beacon.faint },
  center: { paddingVertical: 40, alignItems: 'center' },
  emptyCard: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 22,
    alignItems: 'center',
    gap: 6,
  },
  emptyTitle: { color: Beacon.text, fontSize: 15, fontWeight: '700', marginTop: 4 },
  emptyText: { color: Beacon.muted, fontSize: 12.5, textAlign: 'center', lineHeight: 18 },
  card: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 12,
    marginBottom: 10,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: Beacon.text, fontSize: 14.5, fontWeight: '700' },
  cardMeta: { color: Beacon.muted, fontSize: 12, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionDanger: { borderColor: 'rgba(248,113,113,0.35)', marginLeft: 'auto' },
  actionText: { color: Beacon.text, fontSize: 12.5, fontWeight: '600' },
  err: { color: '#f87171', fontSize: 12.5, textAlign: 'center', marginTop: 8, marginBottom: 8 },
});
