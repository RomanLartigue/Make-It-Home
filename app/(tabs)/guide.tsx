import React from 'react';
import { View, Text, StyleSheet, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon } from '@/constants/beacon';
import { Card, Callout } from '@/components/beacon/kit';

const STEPS = [
  { n: '1', title: 'Hold the beacon', desc: 'Hold the orange button, then release in the center to go live instantly.' },
  { n: '2', title: 'Or swipe to a timer', desc: 'While holding, drag toward 15, 30, 45, or 60 minutes to start a check-in.' },
  { n: '3', title: "You're covered", desc: 'Your circle gets your live location, a live camera view, and a saved recording.' },
  { n: '4', title: '“Made it home”', desc: 'End the session and we let your circle know you’re safe.' },
];

const FEATURES: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'layers-outline',
    title: 'Escalation ladder',
    body:
      'Group your circle into tiers. Your first responders are alerted the moment you go live. If no one taps “I’m on my way,” the next tier is alerted automatically — climbing until someone responds. Set it up in Settings → Escalation ladder.',
  },
  {
    icon: 'videocam-outline',
    title: 'Live video & recording',
    body:
      'Going live starts recording and shares a near-live camera view on your link, so your circle can see what’s happening. They can download the recording to show police if needed — and a copy is always saved to your own photos.',
  },
  {
    icon: 'call-outline',
    title: 'Fake call',
    body:
      'Need a way out? Tap the phone icon at the top of the Home screen for a realistic incoming call — choose who’s calling and when. It never contacts anyone; it just gives you a natural reason to step away.',
  },
];

export default function GuideScreen() {
  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Guide</Text>
        <Text style={styles.sub}>How Make It Home keeps you covered — always here if you forget.</Text>

        <Text style={styles.secLabel}>Going live</Text>
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

        <Text style={styles.secLabel}>Features</Text>
        {FEATURES.map(f => (
          <Card key={f.title} style={styles.featureCard}>
            <View style={styles.featureIcon}>
              <Ionicons name={f.icon} size={18} color={Beacon.beacon} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{f.title}</Text>
              <Text style={styles.cardBody}>{f.body}</Text>
            </View>
          </Card>
        ))}

        <Text style={styles.secLabel}>What your circle sees</Text>
        <Card style={{ paddingVertical: 12, gap: 4 }}>
          <Text style={styles.cardTitle}>A link — no app, no account</Text>
          <Text style={styles.cardBody}>
            Each person gets a text with your name, live location, and a live camera view. They tap
            “I&apos;m on my way” to say they’ve got it — which stops the ladder from alerting anyone
            else, so help isn&apos;t duplicated and no one double-panics.
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
  featureCard: { flexDirection: 'row', gap: 12, paddingVertical: 13, marginBottom: 8, alignItems: 'flex-start' },
  featureIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#241017',
    borderWidth: 1,
    borderColor: '#5a2b23',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: Beacon.text },
  cardBody: { fontSize: 12.5, color: Beacon.muted, lineHeight: 18, marginTop: 2 },
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
