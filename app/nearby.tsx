import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Linking, Platform, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout } from '@/components/beacon/kit';
import { GoldUpsell, GoldBadge } from '@/components/beacon/GoldGate';
import { useGold } from '@/utils/gold';
import { getServerUrl, fetchWithAuth } from '@/utils/serverUrl';

interface Place {
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  phone: string | null;
  address: string | null;
}
interface Nearby {
  police: Place[];
  hospital: Place[];
  fire_station: Place[];
  radiusKm: number;
}

const SECTIONS: { key: keyof Omit<Nearby, 'radiusKm'>; title: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: 'police', title: 'Police stations', icon: 'shield-checkmark', color: '#5aa2ff' },
  { key: 'hospital', title: 'Hospitals', icon: 'medkit', color: '#ff6a4d' },
  { key: 'fire_station', title: 'Fire stations', icon: 'flame', color: '#ffb020' },
];

function directions(lat: number, lng: number, label: string) {
  const q = encodeURIComponent(label);
  const url =
    Platform.OS === 'ios'
      ? `http://maps.apple.com/?daddr=${lat},${lng}&q=${q}`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  Linking.openURL(url).catch(() => {});
}

export default function NearbyScreen() {
  const router = useRouter();
  const gold = useGold();
  const [data, setData] = useState<Nearby | null>(null);
  const [state, setState] = useState<'idle' | 'locating' | 'loading' | 'ready' | 'noloc' | 'error'>('idle');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState('locating');
      let perm = await Location.getForegroundPermissionsAsync();
      if (!perm.granted) perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) {
        setState('noloc');
        return;
      }
      const loc =
        (await Location.getLastKnownPositionAsync().catch(() => null)) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      setState('loading');
      const serverUrl = await getServerUrl();
      const res = await fetchWithAuth(
        `${serverUrl}/nearby?lat=${loc.coords.latitude}&lng=${loc.coords.longitude}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setState('ready');
    } catch {
      setState('error');
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

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Nearby help" onBack={() => router.back()} />
      </View>

      {!gold ? (
        <ScrollView contentContainerStyle={styles.body}>
          <GoldUpsell
            title="Local safety info"
            body="See the nearest police stations, hospitals and fire stations to wherever you are — with distance, one-tap directions and call. Useful to know before you need it."
          />
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Beacon.muted} />}
        >
          <View style={styles.secRow}>
            <Text style={styles.secLabel}>
              {data ? `Within ${data.radiusKm} km of you` : 'Around you'}
            </Text>
            <GoldBadge />
          </View>

          <View style={styles.emergency}>
            <Ionicons name="call" size={16} color="#fff" />
            <Text style={styles.emergencyText}>
              In a real emergency, call your local emergency number (911 in the US) first.
            </Text>
          </View>

          {(state === 'locating' || state === 'loading') && (
            <View style={styles.center}>
              <ActivityIndicator color={Beacon.muted} />
              <Text style={styles.centerText}>{state === 'locating' ? 'Finding your location…' : 'Looking up nearby services…'}</Text>
            </View>
          )}
          {state === 'noloc' && (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>Location access is needed to find services near you.</Text>
              <Pressable style={styles.retry} onPress={() => Linking.openSettings()}>
                <Text style={styles.retryText}>Open Settings</Text>
              </Pressable>
            </View>
          )}
          {state === 'error' && (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>Couldn’t load nearby services right now.</Text>
              <Pressable style={styles.retry} onPress={load}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          )}

          {state === 'ready' && data && SECTIONS.map(sec => {
            const list = data[sec.key] || [];
            return (
              <View key={sec.key} style={{ marginTop: 16 }}>
                <View style={styles.secHead}>
                  <View style={[styles.secIcon, { backgroundColor: sec.color + '22', borderColor: sec.color + '55' }]}>
                    <Ionicons name={sec.icon} size={15} color={sec.color} />
                  </View>
                  <Text style={styles.secTitle}>{sec.title}</Text>
                  <Text style={styles.secCount}>{list.length ? `${list.length} nearby` : 'none found nearby'}</Text>
                </View>
                {list.length > 0 && (
                  <View style={styles.card}>
                    {list.map((p, i) => (
                      <View key={`${p.lat},${p.lng}`} style={[styles.row, i === list.length - 1 && { borderBottomWidth: 0 }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                          <Text style={styles.meta} numberOfLines={1}>
                            {p.distanceKm} km{p.address ? ` · ${p.address}` : ''}
                          </Text>
                        </View>
                        {p.phone && (
                          <Pressable style={styles.iconBtn} hitSlop={6} onPress={() => Linking.openURL(`tel:${p.phone}`)}>
                            <Ionicons name="call-outline" size={17} color={Beacon.text} />
                          </Pressable>
                        )}
                        <Pressable style={styles.iconBtn} hitSlop={6} onPress={() => directions(p.lat, p.lng, p.name)}>
                          <Ionicons name="navigate-outline" size={17} color={Beacon.text} />
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })}

          <Callout>
            Locations come from OpenStreetMap and may be incomplete or out of date. Always confirm
            before relying on them.
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
  emergency: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#7f1d1d',
    borderRadius: RADIUS.card,
    padding: 12,
  },
  emergencyText: { flex: 1, color: '#fff', fontSize: 12.5, fontWeight: '600', lineHeight: 17 },
  center: { paddingVertical: 36, alignItems: 'center', gap: 10 },
  centerText: { color: Beacon.muted, fontSize: 13 },
  emptyCard: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 18,
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
  },
  emptyText: { color: Beacon.muted, fontSize: 13, textAlign: 'center' },
  retry: { backgroundColor: Beacon.surface2, borderWidth: 1, borderColor: Beacon.line, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  retryText: { color: Beacon.text, fontSize: 13, fontWeight: '700' },
  secHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  secIcon: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secTitle: { color: Beacon.text, fontSize: 14, fontWeight: '700' },
  secCount: { color: Beacon.faint, fontSize: 12, marginLeft: 'auto' },
  card: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    paddingHorizontal: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: Beacon.line },
  name: { color: Beacon.text, fontSize: 14, fontWeight: '600' },
  meta: { color: Beacon.muted, fontSize: 12, marginTop: 1 },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
