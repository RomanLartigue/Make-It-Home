import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { stopBackgroundLocation } from '@/tasks/backgroundLocation';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { hSuccess } from '@/utils/haptics';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getUserName, setUserName, getServerUrl, fetchWithAuth, syncCircle } from '@/utils/serverUrl';
import { getMyPhone, setMyPhone } from '@/utils/push';
import { toE164 } from '@/utils/phoneNumber';
import { setGold } from '@/utils/gold';
import { confirmDestructive } from '@/utils/confirm';
import { Beacon } from '@/constants/beacon';
import { Card, SectionLabel, SRow, PillButton } from '@/components/beacon/kit';

export default function SettingsScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [myPhone, setMyPhoneText] = useState('');
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [serverStatus, setServerStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [locOn, setLocOn] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getUserName().then(setName);
      getMyPhone().then(p => setMyPhoneText(p || '')).catch(() => {});
      Location.getForegroundPermissionsAsync()
        .then(p => setLocOn(!!p.granted))
        .catch(() => {});
      setServerStatus('idle');
    }, []),
  );

  const handleSave = async () => {
    if (!name.trim()) return; // never silently wipe the stored name
    await setUserName(name.trim());
    setSaved(true);
    hSuccess();
    setTimeout(() => setSaved(false), 1600);
  };

  const testConnection = async () => {
    setTesting(true);
    setServerStatus('idle');
    try {
      const serverUrl = await getServerUrl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      // An AUTHENTICATED endpoint on purpose: /health is auth-exempt, so a
      // device that could never register (broken build secret) still showed
      // "✓ you're ready" here while every real alert would 401.
      const res = await fetchWithAuth(`${serverUrl}/circles/mine`, { signal: controller.signal });
      clearTimeout(timer);
      setServerStatus(res.ok ? 'ok' : 'error');
    } catch {
      setServerStatus('error');
    } finally {
      setTesting(false);
    }
  };

  const handleSavePhone = async () => {
    if (phoneSaving) return; // a double-tap would request two verification codes
    setPhoneError(null);
    const raw = myPhone.trim();
    setPhoneSaving(true);
    try {
      if (!raw) {
        // Cleared on purpose: stop notification delivery, alerts go back to texts.
        const err = await setMyPhone(null);
        if (err) {
          setPhoneError(err);
          return;
        }
        setPhoneSaved(true);
        hSuccess();
        setTimeout(() => setPhoneSaved(false), 1600);
        return;
      }
      const e164 = toE164(raw);
      if (!e164) {
        setPhoneError('That doesn’t look like a dialable number. US: 212 555 1234 — elsewhere, include the +country code.');
        return;
      }
      setMyPhoneText(e164);
      // setMyPhone registers with the server; a NEW number triggers the texted
      // 6-digit verification code (the prompt appears on its own).
      const err = await setMyPhone(e164);
      if (err) {
        setPhoneError(err);
        return;
      }
      setPhoneSaved(true);
      hSuccess();
      setTimeout(() => setPhoneSaved(false), 1600);
    } finally {
      setPhoneSaving(false);
    }
  };

  const deleteMyData = async () => {
    // A live safety session must be ended BY THE USER first: deleting data
    // mid-session would strand the GPS task and tear the session's owner out
    // from under the circle's live view.
    const activeSession = await AsyncStorage.getItem('@makeithome_active_session').catch(() => null);
    if (activeSession) {
      Alert.alert(
        'End your session first',
        'You have a safety session running. Press "I’m safe" on the Home tab, then delete your data.',
      );
      return;
    }
    // Same for a pending check-in: wiping locally while the SERVER timer kept
    // running meant the circle got a "missed check-in" emergency text an hour
    // after the user believed everything was erased.
    const pendingCheckIn = await AsyncStorage.getItem('@makeithome_checkin').catch(() => null);
    if (pendingCheckIn) {
      Alert.alert(
        'Cancel your check-in first',
        'You have a Home-safe check-in running. Mark yourself safe on the Home tab, then delete your data.',
      );
      return;
    }
    confirmDestructive(
      'Delete my data',
      'This erases your name, safety circle, and check-in state from this device and signs it out. This cannot be undone.',
      'Delete everything',
      async () => {
        // The SERVER delete must succeed before anything is wiped locally:
        // offline, the old flow "succeeded" into onboarding while the server
        // kept the circle, the push registration, and any timers.
        try {
          const serverUrl = await getServerUrl();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const res = await fetchWithAuth(`${serverUrl}/account/delete`, {
            method: 'POST',
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
        } catch {
          Alert.alert(
            "Couldn't reach the server",
            'Your data was NOT deleted. Connect to the internet and try again, so the copy on our server is erased too.',
          );
          return;
        }
        // Stop the native background-location task (it survives relaunches —
        // without this a crashed session's GPS would run until reinstall) and
        // drop any scheduled check-in warning notifications.
        if (Platform.OS !== 'web') {
          await stopBackgroundLocation().catch(() => {});
          await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
        }
        // (Push un-registration and the server purge already happened in the
        // /account/delete above — the server now cleans the phone→push binding
        // itself, so no extra calls that could mint a fresh token post-delete.)
        // Reset the in-memory Gold cache too — wiping only the stored flag
        // leaves Gold active until the next app restart.
        await setGold(false).catch(() => {});
        const keys = await AsyncStorage.getAllKeys();
        const mine = keys.filter(k => k.startsWith('@makeithome'));
        if (mine.length) await AsyncStorage.multiRemove(mine);
        router.replace('/onboarding');
      },
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={styles.h1}>Settings</Text>

        <SectionLabel>Account</SectionLabel>
        <Card style={{ paddingVertical: 12 }}>
          <Text style={styles.fieldLabel}>Your name</Text>
          <Text style={styles.fieldHint}>Shown in the alert so your circle knows whose session it is.</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Jordan"
            placeholderTextColor={Beacon.faint}
            autoCapitalize="words"
            returnKeyType="done"
          />
          <PillButton
            title={saved ? '✓ Saved' : 'Save'}
            kind={saved ? 'dark' : 'primary'}
            onPress={handleSave}
            disabled={!name.trim()}
            style={{ marginTop: 10 }}
          />
        </Card>
        <Card style={{ marginTop: 8, paddingVertical: 12 }}>
          <Text style={styles.fieldLabel}>Your phone number</Text>
          <Text style={styles.fieldHint}>
            Optional. With it, circle alerts reach you here as notifications (we text a quick code
            to confirm it&apos;s yours). Without it, you get texts. Clear it to switch back.
          </Text>
          <TextInput
            style={styles.input}
            value={myPhone}
            onChangeText={t => {
              setMyPhoneText(t);
              setPhoneError(null);
            }}
            placeholder="e.g. 212 555 1234"
            placeholderTextColor={Beacon.faint}
            keyboardType="phone-pad"
            returnKeyType="done"
          />
          {phoneError ? <Text style={styles.fieldError}>{phoneError}</Text> : null}
          <PillButton
            title={phoneSaving ? 'Saving…' : phoneSaved ? '✓ Saved' : 'Save number'}
            kind={phoneSaved ? 'dark' : 'primary'}
            onPress={handleSavePhone}
            disabled={phoneSaving}
            style={{ marginTop: 10 }}
          />
        </Card>
        <Card style={{ marginTop: 8, paddingVertical: 2 }}>
          <SRow label="Location" value={locOn ? 'On' : 'Off'} valueColor={locOn ? Beacon.safe : undefined} last />
        </Card>

        <SectionLabel>Safety</SectionLabel>
        <Card style={{ paddingVertical: 2 }}>
          <SRow label="Escalation" value="›" onPress={() => router.push('/escalation')} last />
        </Card>

        <SectionLabel>Help</SectionLabel>
        <Card style={{ paddingVertical: 2 }}>
          <SRow label="Guide — how it works" value="›" onPress={() => router.push('/guide')} last />
        </Card>

        <SectionLabel>Server</SectionLabel>
        <Card style={{ paddingVertical: 12 }}>
          <Text style={styles.fieldHint}>Verify the app can reach the server before an emergency.</Text>
          {testing ? (
            <View style={styles.testingRow}>
              <ActivityIndicator color={Beacon.text} size="small" />
              <Text style={{ color: Beacon.muted, fontSize: 13 }}>Testing…</Text>
            </View>
          ) : (
            <PillButton title="Test connection" kind="dark" onPress={testConnection} style={{ marginTop: 10 }} />
          )}
          {!testing && serverStatus !== 'idle' && (
            <Text
              style={[
                styles.serverStatus,
                { color: serverStatus === 'ok' ? Beacon.safe : '#f87171' },
              ]}>
              {serverStatus === 'ok'
                ? "✓ Server reachable — you're ready."
                : '✕ Could not reach server. Check your network.'}
            </Text>
          )}
        </Card>

        <SectionLabel>About</SectionLabel>
        <Card style={{ paddingVertical: 2 }}>
          <SRow label="Terms of Service" value="›" onPress={() => router.push('/legal?doc=terms')} />
          <SRow label="Privacy Policy" value="›" onPress={() => router.push('/legal?doc=privacy')} last />
        </Card>

        <Card style={{ marginTop: 12, paddingVertical: 2 }}>
          <SRow label="Delete my data" danger onPress={deleteMyData} right={<View />} last />
        </Card>

        <Text style={styles.version}>
          Make It Home · v{(Constants as any)?.expoConfig?.version ?? '1.0'}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Beacon.night },
  scroll: { paddingHorizontal: 20, paddingBottom: 60 },
  h1: { fontSize: 22, fontWeight: '800', color: Beacon.text, marginTop: 8, letterSpacing: -0.3 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: Beacon.text, marginBottom: 4 },
  fieldHint: { fontSize: 12, color: Beacon.muted, lineHeight: 17 },
  fieldError: { fontSize: 12, color: Beacon.hot, marginTop: 8, lineHeight: 17 },
  input: {
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: Beacon.text,
    fontSize: 15,
    marginTop: 10,
  },
  testingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, paddingVertical: 6 },
  serverStatus: { fontSize: 12.5, marginTop: 10, lineHeight: 18 },
  version: { textAlign: 'center', color: Beacon.faint, fontSize: 12, marginTop: 28 },
});
