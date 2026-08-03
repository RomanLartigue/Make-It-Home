import React from 'react';
import { View, Text, StyleSheet, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon } from '@/constants/beacon';
import { Card, Callout } from '@/components/beacon/kit';

const STEPS = [
  { n: '1', title: 'Hold the beacon', desc: 'Hold, then release in the center to go live instantly.' },
  { n: '2', title: 'Or swipe to a timer', desc: 'While holding, drag toward 15, 30, 45, or 60 minutes for a check-in.' },
  { n: '3', title: "You're covered", desc: 'Your circle gets your live location and a recording.' },
  { n: '4', title: '“Made it home”', desc: 'End the session and we let your circle know you’re safe.' },
];

export default function GuideScreen() {
  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Guide</Text>
        <Text style={styles.sub}>How Make It Home keeps you covered — always here if you forget.</Text>

        {STEPS.map(s => (
          <View key={s.n} style={styles.step}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{s.n}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.stepTitle}>{s.title}</Text>
              <Text style={styles.stepDesc}>{s.desc}</Text>
            </View>
          </View>
        ))}

        <Text style={styles.secLabel}>What your circle sees</Text>
        <Card style={{ paddingVertical: 12, gap: 4 }}>
          <Text style={styles.cardTitle}>A link — no app, no account</Text>
          <Text style={styles.cardBody}>
            When you signal, each person gets a text with a live map and your name. They can tap
            “I&apos;m on my way,” and your other contacts see it too — so help isn&apos;t duplicated
            and no one double-panics.
          </Text>
        </Card>

        <Callout>
          Make It Home is not a replacement for 911. In a life-threatening emergency, call your
          local emergency number directly.
        </Callout>

        <View style={{ height: 18 }} />
        <View style={styles.support}>
          <Ionicons name="chatbubbles-outline" size={16} color={Beacon.beacon} />
          <Text style={styles.supportText} onPress={() => Linking.openURL('mailto:support@makeithome.app')}>
            Contact support
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  h1: { fontSize: 22, fontWeight: '800', color: Beacon.text, marginTop: 8, letterSpacing: -0.3 },
  sub: { fontSize: 12.5, color: Beacon.muted, marginTop: 4, marginBottom: 6 },
  step: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#241017',
    borderWidth: 1,
    borderColor: '#5a2b23',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { color: Beacon.beacon, fontWeight: '800', fontSize: 12 },
  stepTitle: { fontSize: 13.5, fontWeight: '700', color: Beacon.text },
  stepDesc: { fontSize: 12, color: Beacon.muted, marginTop: 1, lineHeight: 17 },
  secLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Beacon.faint,
    marginTop: 18,
    marginBottom: 6,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: Beacon.text },
  cardBody: { fontSize: 12.5, color: Beacon.muted, lineHeight: 18 },
  support: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 12,
    paddingVertical: 13,
    marginTop: 4,
  },
  supportText: { color: Beacon.text, fontWeight: '700', fontSize: 13.5 },
});
