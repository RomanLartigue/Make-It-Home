import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Animated,
  Pressable,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { setUserName } from '@/utils/serverUrl';
import { setMyPhone } from '@/utils/push';
import { toE164 } from '@/utils/phoneNumber';
import { Beacon } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';

const ONBOARDED_KEY = '@makeithome_onboarded';

export default function OnboardingScreen() {
  const router = useRouter();
  const fade = useRef(new Animated.Value(1)).current;
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [locLabel, setLocLabel] = useState('Location is off');
  const [locGranted, setLocGranted] = useState(false);

  const goStep = (next: number) => {
    Animated.timing(fade, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      setStep(next);
      Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  };

  const finish = async () => {
    if (name.trim()) await setUserName(name.trim());
    // Registering the number makes THIS phone reachable by push: whenever
    // someone's safety circle contains it, sliding their beacon reaches this
    // device as a free notification instead of a text. Best-effort — a
    // skipped or failed registration just means texts, never a blocked user.
    const e164 = toE164(phone.trim());
    if (e164) setMyPhone(e164).catch(() => {});
    await AsyncStorage.setItem(ONBOARDED_KEY, 'true');
    router.replace('/(tabs)');
  };

  const continueFromName = () => {
    if (!name.trim()) return;
    const raw = phone.trim();
    if (raw && !toE164(raw)) {
      setPhoneErr('That number doesn’t look right — e.g. 212 555 1234. You can also leave it empty.');
      return;
    }
    setPhoneErr(null);
    goStep(1);
  };

  const allowLocation = async () => {
    setLocLabel('Locating…');
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (granted) {
        setLocGranted(true);
        setLocLabel('Location on');
        setTimeout(finish, 600);
      } else {
        setLocLabel('Permission denied — you can enable it later in Settings');
      }
    } catch {
      setLocLabel("Couldn't get location — you can enable it later");
    }
  };

  const Dots = ({ active }: { active: number }) => (
    <View style={styles.dots}>
      {[0, 1, 2].map(i => (
        <View key={i} style={[styles.dot, i === active && styles.dotOn]} />
      ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.root}>
      {/* Keyboard-safe layout: the view shrinks to sit above ANY keyboard size
          (large accessibility keyboards included), the content scrolls when it
          doesn't fit, and tapping anywhere outside the field dismisses the
          keyboard. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <Pressable style={styles.tapCatcher} onPress={Keyboard.dismiss} accessible={false}>
            <Animated.View style={[styles.content, { opacity: fade }]}>
        {step === 0 && (
          <View style={styles.ob}>
            <Dots active={0} />
            <Text style={styles.h2}>What should I call you?</Text>
            <Text style={styles.p}>
              Your circle sees this if you ever need them — a name or a nickname is perfect.
            </Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="First name or nickname"
              placeholderTextColor={Beacon.faint}
              autoCapitalize="words"
              autoFocus
              returnKeyType="next"
            />
            <Text style={styles.p}>
              And your phone number — when someone adds you to their safety circle, their alerts
              reach you right here as notifications instead of texts. (Optional)
            </Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={t => {
                setPhone(t);
                setPhoneErr(null);
              }}
              placeholder="Your phone number (optional)"
              placeholderTextColor={Beacon.faint}
              keyboardType="phone-pad"
              returnKeyType="done"
              onSubmitEditing={continueFromName}
            />
            {phoneErr ? <Text style={styles.err}>{phoneErr}</Text> : null}
            <PillButton
              title="Continue"
              onPress={continueFromName}
              style={{ marginTop: 14, opacity: name.trim() ? 1 : 0.5 }}
            />
          </View>
        )}

        {step === 1 && (
          <View style={styles.ob}>
            <Dots active={1} />
            <Text style={styles.h2}>How Make It Home works</Text>
            <Text style={styles.p}>Please read this — it&apos;s important. By continuing you agree to our terms.</Text>
            <View style={styles.legalBox}>
              <Text style={styles.legalHead}>The essentials</Text>
              <Text style={styles.legalBody}>
                Make It Home is <Text style={{ fontWeight: '700' }}>not a substitute for 911</Text>. We
                only alert your circle when you trigger it, delivery isn&apos;t guaranteed, and your
                data is kept briefly and auto-deleted.
              </Text>
              <Text style={[styles.legalBody, { marginTop: 8 }]}>
                By adding contacts, you confirm they&apos;ve agreed to receive safety text messages
                from you. Message &amp; data rates may apply; reply STOP to opt out.
              </Text>
            </View>
            <View style={styles.legalLinks}>
              <Text style={styles.legalLink} onPress={() => router.push('/legal?doc=terms')}>
                Full Terms of Service
              </Text>
              <Text style={{ color: Beacon.faint }}> · </Text>
              <Text style={styles.legalLink} onPress={() => router.push('/legal?doc=privacy')}>
                Privacy Policy
              </Text>
            </View>
            <PillButton title="Agree & continue" onPress={() => goStep(2)} style={{ marginTop: 14 }} />
          </View>
        )}

        {step === 2 && (
          <View style={styles.ob}>
            <Dots active={2} />
            <Text style={styles.h2}>Turn on location</Text>
            <Text style={styles.p}>
              Make It Home shares where you are with your circle during a safety session — it&apos;s
              the core of keeping you looked after, so we ask up front.
            </Text>
            <View style={[styles.locStat, locGranted && styles.locStatOk]}>
              <Text style={{ color: locGranted ? Beacon.safe : Beacon.muted, fontSize: 12.5 }}>
                {locLabel}
              </Text>
            </View>
            <PillButton title="Allow location" onPress={allowLocation} style={{ marginTop: 14 }} />
            <Pressable onPress={finish} style={styles.skip}>
              <Text style={styles.skipText}>Not now</Text>
            </Pressable>
          </View>
        )}
            </Animated.View>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  scroll: { flexGrow: 1 },
  tapCatcher: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 24 },
  content: {},
  ob: { gap: 13 },
  dots: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  dot: { width: 22, height: 4, borderRadius: 2, backgroundColor: Beacon.line },
  dotOn: { width: 30, backgroundColor: Beacon.beacon },
  h2: { fontSize: 24, fontWeight: '800', color: Beacon.text, letterSpacing: -0.4 },
  p: { color: Beacon.muted, fontSize: 13.5, lineHeight: 20 },
  err: { color: Beacon.hot, fontSize: 12.5, lineHeight: 18 },
  input: {
    marginTop: 4,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 15,
    color: Beacon.text,
    fontSize: 16,
    fontWeight: '600',
  },
  legalBox: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 14,
    padding: 14,
  },
  legalHead: {
    color: Beacon.text,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 5,
  },
  legalBody: { color: Beacon.muted, fontSize: 12.5, lineHeight: 20 },
  legalLinks: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  legalLink: { color: Beacon.info, fontWeight: '700', fontSize: 12.5 },
  locStat: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  locStatOk: { borderColor: '#1f4d3f' },
  skip: { alignItems: 'center', paddingVertical: 12 },
  skipText: { color: Beacon.muted, fontSize: 13, fontWeight: '600' },
});
