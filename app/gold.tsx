import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout } from '@/components/beacon/kit';
import { GOLD, GoldBadge } from '@/components/beacon/GoldGate';
import { GOLD_PRICING, useGold, setGold, openManageSubscription } from '@/utils/gold';

type Plan = 'individual' | 'family';
type Cycle = 'monthly' | 'yearly';

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'notifications-outline',
    title: 'Your own escalation timing',
    body: 'Choose exactly when your circle is re-texted if no one responds — and how many times. Free uses a fixed 5 / 10 / 15 minute schedule.',
  },
  {
    icon: 'cloud-outline',
    title: 'Cloud recording history',
    body: 'Every session’s recording kept safely in the cloud for 90 days — view or download any time, from any device. Free keeps a copy on your phone plus a 24-hour link.',
  },
  {
    icon: 'map-outline',
    title: 'Local safety info',
    body: 'Nearest police stations, hospitals and fire stations to where you are, with distance, directions and one-tap call.',
  },
];

export default function GoldScreen() {
  const router = useRouter();
  const gold = useGold();
  const [plan, setPlan] = useState<Plan>('individual');
  const [cycle, setCycle] = useState<Cycle>('yearly');

  const price = GOLD_PRICING[plan][cycle];
  const perMonth = cycle === 'yearly' ? price / 12 : price;

  const onSubscribe = () => {
    // Real purchase flow (App Store / Google Play via RevenueCat) is the next
    // step. For now this explains that, and testing uses the dev toggle below.
    Alert.alert(
      'Coming soon',
      'Subscriptions will be available through the App Store shortly. Thanks for supporting Make It Home — it keeps the safety features free for everyone.',
    );
  };

  const toggleDev = async () => {
    await setGold(!gold);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Make It Home Gold" onBack={() => router.back()} />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="star" size={26} color={GOLD} />
          </View>
          <Text style={styles.heroTitle}>
            The button that gets you help is <Text style={{ color: GOLD }}>free, forever.</Text>
          </Text>
          <Text style={styles.heroSub}>
            Gold only adds things on top — and helps keep the core free for everyone.
          </Text>
          {gold && (
            <View style={styles.activePill}>
              <Ionicons name="checkmark-circle" size={14} color={Beacon.safe} />
              <Text style={styles.activeText}>Gold is active on this device</Text>
            </View>
          )}
        </View>

        <Text style={styles.secLabel}>What Gold adds</Text>
        {FEATURES.map(f => (
          <View key={f.title} style={styles.feature}>
            <View style={styles.featureIcon}>
              <Ionicons name={f.icon} size={18} color={GOLD} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.featureTitle}>{f.title}</Text>
              <Text style={styles.featureBody}>{f.body}</Text>
            </View>
          </View>
        ))}

        <Text style={styles.secLabel}>Choose a plan</Text>
        <View style={styles.planRow}>
          <PlanCard
            active={plan === 'individual'}
            onPress={() => setPlan('individual')}
            title="Individual"
            sub="Just you"
            price={GOLD_PRICING.individual[cycle]}
            cycle={cycle}
          />
          <PlanCard
            active={plan === 'family'}
            onPress={() => setPlan('family')}
            title="Family"
            sub="Up to 5 people"
            price={GOLD_PRICING.family[cycle]}
            cycle={cycle}
            best
          />
        </View>

        <View style={styles.cycleRow}>
          {(['monthly', 'yearly'] as Cycle[]).map(c => {
            const on = cycle === c;
            return (
              <Pressable key={c} style={[styles.cycleChip, on && styles.cycleOn]} onPress={() => setCycle(c)}>
                <Text style={[styles.cycleText, on && { color: Beacon.text }]}>
                  {c === 'monthly' ? 'Monthly' : 'Yearly'}
                </Text>
                {c === 'yearly' && <Text style={styles.save}>save ~33%</Text>}
              </Pressable>
            );
          })}
        </View>

        {gold ? (
          <Pressable style={styles.subscribe} onPress={openManageSubscription}>
            <Text style={styles.subscribeText}>Manage subscription</Text>
            <Text style={styles.subscribeSub}>Change plan or cancel in the App Store</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.subscribe} onPress={onSubscribe}>
            <Text style={styles.subscribeText}>
              Get Gold {plan === 'family' ? 'Family' : 'Individual'} · ${price.toFixed(2)}/{cycle === 'yearly' ? 'yr' : 'mo'}
            </Text>
            <Text style={styles.subscribeSub}>≈ ${perMonth.toFixed(2)}/month{cycle === 'yearly' ? ', billed yearly' : ''}</Text>
          </Pressable>
        )}
        <Text style={styles.fine}>
          Cancel anytime. Nothing in the free app is ever taken away.
        </Text>

        <Callout>
          Gold Family covers you and up to 4 people you choose — perfect for a household or the people in
          your safety circle.
        </Callout>

        {/* Dev toggle — removed when real purchases ship */}
        <Pressable style={styles.dev} onPress={toggleDev} onLongPress={toggleDev}>
          <Ionicons name="construct-outline" size={14} color={Beacon.faint} />
          <Text style={styles.devText}>Testing: turn Gold {gold ? 'OFF' : 'ON'} on this device</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function PlanCard({
  active,
  onPress,
  title,
  sub,
  price,
  cycle,
  best,
}: {
  active: boolean;
  onPress: () => void;
  title: string;
  sub: string;
  price: number;
  cycle: Cycle;
  best?: boolean;
}) {
  return (
    <Pressable style={[styles.plan, active && styles.planOn]} onPress={onPress}>
      {best && (
        <View style={styles.bestPill}>
          <Text style={styles.bestText}>BEST VALUE</Text>
        </View>
      )}
      <Text style={styles.planTitle}>{title}</Text>
      <Text style={styles.planSub}>{sub}</Text>
      <Text style={styles.planPrice}>
        ${price.toFixed(2)}
        <Text style={styles.planPer}>/{cycle === 'yearly' ? 'yr' : 'mo'}</Text>
      </Text>
      <View style={[styles.radio, active && styles.radioOn]}>
        {active && <Ionicons name="checkmark" size={12} color="#1a1200" />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  body: { paddingHorizontal: 20, paddingBottom: 44 },
  hero: { alignItems: 'center', paddingVertical: 14 },
  heroIcon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: 'rgba(245,185,66,0.12)',
    borderWidth: 1,
    borderColor: '#4a3c14',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  heroTitle: { color: Beacon.text, fontSize: 19, fontWeight: '800', textAlign: 'center', lineHeight: 26, maxWidth: 320 },
  heroSub: { color: Beacon.muted, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19, maxWidth: 320 },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    backgroundColor: 'rgba(75,214,166,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(75,214,166,0.4)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  activeText: { color: Beacon.safe, fontSize: 12.5, fontWeight: '700' },

  secLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Beacon.faint,
    marginTop: 18,
    marginBottom: 8,
  },
  feature: { flexDirection: 'row', gap: 12, paddingVertical: 10, alignItems: 'flex-start' },
  featureIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(245,185,66,0.12)',
    borderWidth: 1,
    borderColor: '#4a3c14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureTitle: { color: Beacon.text, fontSize: 14, fontWeight: '700' },
  featureBody: { color: Beacon.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 },

  planRow: { flexDirection: 'row', gap: 10 },
  plan: {
    flex: 1,
    backgroundColor: Beacon.surface,
    borderWidth: 1.5,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 14,
    paddingTop: 18,
  },
  planOn: { borderColor: GOLD, backgroundColor: '#1e1a12' },
  bestPill: {
    position: 'absolute',
    top: -9,
    left: 12,
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  bestText: { color: '#1a1200', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  planTitle: { color: Beacon.text, fontSize: 15, fontWeight: '800' },
  planSub: { color: Beacon.muted, fontSize: 12, marginTop: 1 },
  planPrice: { color: Beacon.text, fontSize: 22, fontWeight: '800', marginTop: 10 },
  planPer: { color: Beacon.muted, fontSize: 12, fontWeight: '600' },
  radio: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { backgroundColor: GOLD, borderColor: GOLD },

  cycleRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  cycleChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 999,
    paddingVertical: 11,
  },
  cycleOn: { borderColor: GOLD, backgroundColor: '#1e1a12' },
  cycleText: { color: Beacon.muted, fontSize: 13.5, fontWeight: '700' },
  save: { color: GOLD, fontSize: 11, fontWeight: '800' },

  subscribe: {
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  subscribeText: { color: '#1a1200', fontSize: 15.5, fontWeight: '800' },
  subscribeSub: { color: 'rgba(26,18,0,0.7)', fontSize: 11.5, fontWeight: '600', marginTop: 2 },
  fine: { color: Beacon.faint, fontSize: 11.5, textAlign: 'center', marginTop: 10, marginBottom: 6 },

  dev: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 22,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderStyle: 'dashed',
    borderRadius: 10,
  },
  devText: { color: Beacon.faint, fontSize: 12 },
});
