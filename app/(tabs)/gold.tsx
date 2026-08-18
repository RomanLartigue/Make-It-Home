import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon, RADIUS } from '@/constants/beacon';
import { GOLD, GoldBadge } from '@/components/beacon/GoldGate';
import { useGold, openManageSubscription } from '@/utils/gold';

// The Gold tab: one always-visible home for the three Gold features and the
// plan itself. Free users see the same hub (nothing is hidden) — each feature
// explains what it does and links to the upgrade; Gold users just use it.

const ITEMS: {
  route: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  title: string;
  body: string;
}[] = [
  {
    route: '/nearby',
    icon: 'shield-checkmark',
    color: '#5aa2ff',
    title: 'Nearby help',
    body: 'Nearest police, hospitals and fire stations — distance, call, directions.',
  },
  {
    route: '/history',
    icon: 'cloud-outline',
    color: '#4bd6a6',
    title: 'Recording history',
    body: 'Every session’s recording, kept safely for 90 days. View, download or delete.',
  },
  {
    route: '/escalation',
    icon: 'notifications-outline',
    color: Beacon.beacon,
    title: 'Your escalation timing',
    body: 'Choose exactly when — and how many times — your circle is re-texted.',
  },
];

export default function GoldTab() {
  const router = useRouter();
  const gold = useGold();

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hbar}>
          <Text style={styles.h1}>
            Make It Home <Text style={{ color: GOLD }}>Gold</Text>
          </Text>
          {gold && <GoldBadge />}
        </View>

        {/* Plan card. Free → the plan/paywall screen. Gold → manage subscription. */}
        <Pressable
          style={[styles.plan, gold && styles.planActive]}
          onPress={gold ? openManageSubscription : () => router.push('/gold-plans')}
        >
          <View style={styles.planIcon}>
            <Ionicons name={gold ? 'checkmark-circle' : 'star'} size={22} color={gold ? Beacon.safe : GOLD} />
          </View>
          <View style={{ flex: 1 }}>
            {gold ? (
              <>
                <Text style={styles.planTitle}>Gold is active</Text>
                <Text style={styles.planSub}>Manage your subscription — change plan or cancel.</Text>
              </>
            ) : (
              <>
                <Text style={styles.planTitle}>Get Make It Home Gold</Text>
                <Text style={styles.planSub}>
                  From $4.99/mo · Family (up to 5) $9.99/mo. Only ever adds on top — nothing free is taken away.
                </Text>
              </>
            )}
          </View>
          <Ionicons name={gold ? 'open-outline' : 'chevron-forward'} size={gold ? 16 : 18} color={Beacon.faint} />
        </Pressable>
        {gold && (
          <Text style={styles.thanks}>Thanks for keeping the safety button free for everyone. ♥</Text>
        )}

        <Text style={styles.secLabel}>{gold ? 'Your Gold features' : 'What you get'}</Text>
        {ITEMS.map(it => (
          // Free: the rows are a showcase — any tap leads to the Gold info screen
          // (the "Get Gold" button is the real CTA). Gold: rows open the feature.
          <Pressable
            key={it.route}
            style={styles.item}
            onPress={() => router.push((gold ? it.route : '/gold-plans') as any)}
          >
            <View style={[styles.itemIcon, { backgroundColor: it.color + '1f', borderColor: it.color + '55' }]}>
              <Ionicons name={it.icon} size={19} color={it.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.itemTitle}>{it.title}</Text>
              <Text style={styles.itemBody}>{it.body}</Text>
            </View>
            {gold ? (
              <Ionicons name="chevron-forward" size={17} color={Beacon.faint} />
            ) : (
              <Ionicons name="lock-closed" size={15} color={Beacon.faint} />
            )}
          </Pressable>
        ))}

        {!gold && (
          <Pressable style={styles.getBtn} onPress={() => router.push('/gold-plans')}>
            <Ionicons name="star" size={16} color="#1a1200" />
            <Text style={styles.getBtnText}>Get Make It Home Gold</Text>
          </Pressable>
        )}

        <View style={styles.note}>
          <Ionicons name="heart-outline" size={14} color={Beacon.muted} />
          <Text style={styles.noteText}>
            The button that gets you help is free, forever. Gold helps cover the servers and texts so it
            stays that way.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  hbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 14 },
  h1: { fontSize: 22, fontWeight: '800', color: Beacon.text, letterSpacing: -0.3 },

  plan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1e1a12',
    borderWidth: 1,
    borderColor: '#4a3c14',
    borderRadius: RADIUS.card,
    padding: 14,
  },
  planActive: { backgroundColor: 'rgba(75,214,166,0.08)', borderColor: 'rgba(75,214,166,0.35)' },
  planIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  planTitle: { color: Beacon.text, fontSize: 15, fontWeight: '800' },
  planSub: { color: Beacon.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  thanks: { color: Beacon.faint, fontSize: 11.5, textAlign: 'center', marginTop: 8, fontStyle: 'italic' },

  secLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Beacon.faint,
    marginTop: 20,
    marginBottom: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 14,
    marginBottom: 10,
  },
  itemIcon: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { color: Beacon.text, fontSize: 14.5, fontWeight: '700' },
  itemBody: { color: Beacon.muted, fontSize: 12.5, lineHeight: 17, marginTop: 2 },

  getBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingVertical: 14,
    marginTop: 6,
    marginBottom: 4,
  },
  getBtnText: { color: '#1a1200', fontSize: 15.5, fontWeight: '800' },

  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 4, marginTop: 8 },
  noteText: { flex: 1, color: Beacon.muted, fontSize: 12, lineHeight: 17 },
});
