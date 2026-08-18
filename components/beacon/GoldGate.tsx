import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon, RADIUS } from '@/constants/beacon';

export const GOLD = '#f5b942';

/** Small inline "GOLD" pill. */
export function GoldBadge({ style }: { style?: any }) {
  return (
    <View style={[styles.badge, style]}>
      <Ionicons name="star" size={9} color="#1a1200" />
      <Text style={styles.badgeText}>GOLD</Text>
    </View>
  );
}

/**
 * Upsell card shown in place of a Gold feature for free users. Explains the
 * feature and links to the Gold screen. Never blocks a free/safety feature.
 */
export function GoldUpsell({
  title,
  body,
  cta = 'See Make It Home Gold',
}: {
  title: string;
  body: string;
  cta?: string;
}) {
  const router = useRouter();
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.iconWrap}>
          <Ionicons name="star" size={16} color={GOLD} />
        </View>
        <Text style={styles.title}>{title}</Text>
        <GoldBadge />
      </View>
      <Text style={styles.body}>{body}</Text>
      <Pressable style={styles.cta} onPress={() => router.push('/gold')}>
        <Text style={styles.ctaText}>{cta}</Text>
        <Ionicons name="chevron-forward" size={14} color="#1a1200" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: { color: '#1a1200', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6 },
  card: {
    backgroundColor: '#1e1a12',
    borderWidth: 1,
    borderColor: '#4a3c14',
    borderRadius: RADIUS.card,
    padding: 14,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(245,185,66,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, color: Beacon.text, fontSize: 14.5, fontWeight: '700' },
  body: { color: Beacon.muted, fontSize: 12.5, lineHeight: 18, marginTop: 10 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: GOLD,
    borderRadius: 999,
    paddingVertical: 10,
    marginTop: 12,
  },
  ctaText: { color: '#1a1200', fontSize: 13, fontWeight: '800' },
});
