import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Beacon, RADIUS } from '@/constants/beacon';
import { DetailHeader, Callout, PillButton } from '@/components/beacon/kit';
import {
  ESCALATION_TIERS_KEY,
  DEFAULT_TIERS,
  WAIT_OPTIONS,
  Tier,
  tierIdFor,
  nextTierName,
} from '@/constants/escalation';

const CIRCLE_KEY = '@makeithome_safety_circle';

interface SafetyContact {
  id: string;
  name: string;
  phone: string;
  tier?: string;
}

export default function EscalationScreen() {
  const router = useRouter();
  const [circle, setCircle] = useState<SafetyContact[]>([]);
  const [tiers, setTiers] = useState<Tier[]>(DEFAULT_TIERS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [rawCircle, rawTiers] = await Promise.all([
        AsyncStorage.getItem(CIRCLE_KEY),
        AsyncStorage.getItem(ESCALATION_TIERS_KEY),
      ]);
      const c: SafetyContact[] = rawCircle ? JSON.parse(rawCircle) : [];
      const t: Tier[] = rawTiers ? JSON.parse(rawTiers) : DEFAULT_TIERS;
      setTiers(t.length ? t : DEFAULT_TIERS);
      setCircle(c);
      setLoaded(true);
    })();
  }, []);

  const persistTiers = (next: Tier[]) => {
    setTiers(next);
    AsyncStorage.setItem(ESCALATION_TIERS_KEY, JSON.stringify(next)).catch(() => {});
  };
  const persistCircle = (next: SafetyContact[]) => {
    setCircle(next);
    AsyncStorage.setItem(CIRCLE_KEY, JSON.stringify(next)).catch(() => {});
  };

  // Move a contact to the tier above (-1) or below (+1).
  const moveContact = (contactId: string, dir: -1 | 1) => {
    const contact = circle.find(c => c.id === contactId);
    if (!contact) return;
    const curIdx = tiers.findIndex(t => t.id === tierIdFor(contact.tier, tiers));
    const target = curIdx + dir;
    if (target < 0 || target >= tiers.length) return;
    persistCircle(circle.map(c => (c.id === contactId ? { ...c, tier: tiers[target].id } : c)));
  };

  const renameTier = (id: string, name: string) =>
    persistTiers(tiers.map(t => (t.id === id ? { ...t, name } : t)));

  const cycleWait = (id: string) =>
    persistTiers(
      tiers.map(t => {
        if (t.id !== id) return t;
        const i = WAIT_OPTIONS.indexOf(t.waitMinutes);
        return { ...t, waitMinutes: WAIT_OPTIONS[(i + 1) % WAIT_OPTIONS.length] };
      }),
    );

  const addTier = () => {
    const id = `t${Date.now()}`;
    persistTiers([...tiers, { id, name: nextTierName(tiers.length), waitMinutes: 5 }]);
  };

  const removeTier = (id: string) => {
    const idx = tiers.findIndex(t => t.id === id);
    if (idx <= 0) return; // never remove the first tier
    const fallbackId = tiers[idx - 1].id;
    persistCircle(
      circle.map(c => (tierIdFor(c.tier, tiers) === id ? { ...c, tier: fallbackId } : c)),
    );
    persistTiers(tiers.filter(t => t.id !== id));
  };

  const contactsInTier = (tierId: string) =>
    circle.filter(c => tierIdFor(c.tier, tiers) === tierId);

  if (!loaded) {
    return <SafeAreaView style={styles.root} edges={['top']} />;
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={{ paddingHorizontal: 20 }}>
        <DetailHeader title="Escalation ladder" onBack={() => router.back()} />
        <Text style={styles.subttl}>
          Group your circle into tiers. When you go live, the first tier is alerted immediately. If
          no one taps “I’m on my way,” the next tier is alerted after its wait — climbing until
          someone responds.
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 44 }}>
        {circle.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>
              No one in your circle yet.{' '}
              <Text style={styles.link} onPress={() => router.push('/(tabs)/contacts')}>
                Add someone
              </Text>{' '}
              to build your ladder.
            </Text>
          </View>
        ) : (
          tiers.map((tier, i) => {
            const members = contactsInTier(tier.id);
            return (
              <View key={tier.id} style={styles.tierCard}>
                {/* Tier header */}
                <View style={styles.tierHead}>
                  <View style={styles.tierBadge}>
                    <Text style={styles.tierBadgeText}>{i + 1}</Text>
                  </View>
                  <TextInput
                    style={styles.tierName}
                    value={tier.name}
                    onChangeText={t => renameTier(tier.id, t)}
                    placeholder="Tier name"
                    placeholderTextColor={Beacon.faint}
                    maxLength={40}
                  />
                  {i > 0 && (
                    <Pressable onPress={() => removeTier(tier.id)} hitSlop={8} style={styles.trash}>
                      <Ionicons name="trash-outline" size={17} color={Beacon.faint} />
                    </Pressable>
                  )}
                </View>

                {/* Timing */}
                {i === 0 ? (
                  <Text style={styles.timing}>
                    <Ionicons name="flash" size={12} color={Beacon.beacon} /> Alerted immediately
                  </Text>
                ) : (
                  <Pressable style={styles.waitPill} onPress={() => cycleWait(tier.id)}>
                    <Ionicons name="time-outline" size={13} color={Beacon.muted} />
                    <Text style={styles.waitText}>
                      Alert {tier.waitMinutes} min after the tier above, if no response
                    </Text>
                    <Ionicons name="chevron-forward" size={13} color={Beacon.faint} />
                  </Pressable>
                )}

                {/* Members */}
                <View style={styles.members}>
                  {members.length === 0 ? (
                    <Text style={styles.emptyTier}>No one here yet — move someone in with the arrows.</Text>
                  ) : (
                    members.map(c => (
                      <View key={c.id} style={styles.memberRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.memberName}>{c.name}</Text>
                          <Text style={styles.memberPhone}>{c.phone}</Text>
                        </View>
                        <View style={styles.moveBtns}>
                          <Pressable
                            onPress={() => moveContact(c.id, -1)}
                            disabled={i === 0}
                            hitSlop={6}
                            style={[styles.moveBtn, i === 0 && styles.moveDisabled]}>
                            <Ionicons name="chevron-up" size={18} color={Beacon.text} />
                          </Pressable>
                          <Pressable
                            onPress={() => moveContact(c.id, 1)}
                            disabled={i === tiers.length - 1}
                            hitSlop={6}
                            style={[styles.moveBtn, i === tiers.length - 1 && styles.moveDisabled]}>
                            <Ionicons name="chevron-down" size={18} color={Beacon.text} />
                          </Pressable>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              </View>
            );
          })
        )}

        {circle.length > 0 && (
          <PillButton title="+ Add another tier" kind="dark" onPress={addTier} style={{ marginTop: 4 }} />
        )}

        <Callout>
          When a responder taps “I’m on my way” on your live page, the ladder stops — no one in a
          later tier is alerted. Everyone already alerted still sees your live location.
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
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  emptyText: { color: Beacon.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },

  tierCard: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    padding: 14,
    marginBottom: 12,
  },
  tierHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tierBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.beacon,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tierBadgeText: { color: Beacon.beacon, fontSize: 12, fontWeight: '800' },
  tierName: {
    flex: 1,
    color: Beacon.text,
    fontSize: 16,
    fontWeight: '700',
    paddingVertical: 4,
  },
  trash: { padding: 4 },

  timing: { color: Beacon.muted, fontSize: 12, marginTop: 8, marginLeft: 2 },
  waitPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  waitText: { flex: 1, color: Beacon.muted, fontSize: 12.5 },

  members: { marginTop: 6 },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  memberName: { fontSize: 14.5, fontWeight: '600', color: Beacon.text },
  memberPhone: { fontSize: 12, color: Beacon.faint, marginTop: 1 },
  emptyTier: { color: Beacon.faint, fontSize: 12.5, paddingVertical: 10, fontStyle: 'italic' },
  moveBtns: { flexDirection: 'row', gap: 6 },
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
  moveDisabled: { opacity: 0.3 },
});
