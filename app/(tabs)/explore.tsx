import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getUserName, setUserName, getServerUrl, fetchWithAuth } from '@/utils/serverUrl';
import { confirmDestructive } from '@/utils/confirm';
import { Beacon } from '@/constants/beacon';
import { Card, SectionLabel, SRow, PillButton } from '@/components/beacon/kit';

export default function SettingsScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [serverStatus, setServerStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [locOn, setLocOn] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getUserName().then(setName);
      Location.getForegroundPermissionsAsync()
        .then(p => setLocOn(!!p.granted))
        .catch(() => {});
      setServerStatus('idle');
    }, []),
  );

  const handleSave = async () => {
    await setUserName(name);
    setSaved(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setSaved(false), 1600);
  };

  const testConnection = async () => {
    setTesting(true);
    setServerStatus('idle');
    try {
      const serverUrl = await getServerUrl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetchWithAuth(`${serverUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      setServerStatus(res.ok ? 'ok' : 'error');
    } catch {
      setServerStatus('error');
    } finally {
      setTesting(false);
    }
  };

  const deleteMyData = () => {
    confirmDestructive(
      'Delete my data',
      'This erases your name, safety circle, and check-in state from this device and signs it out. This cannot be undone.',
      'Delete everything',
      async () => {
        // Best-effort server-side deletion (endpoint may not exist yet).
        try {
          const serverUrl = await getServerUrl();
          await fetchWithAuth(`${serverUrl}/account/delete`, { method: 'POST' });
        } catch {}
        const keys = await AsyncStorage.getAllKeys();
        const mine = keys.filter(k => k.startsWith('@makeithome'));
        if (mine.length) await AsyncStorage.multiRemove(mine);
        router.replace('/onboarding');
      },
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Settings</Text>

        <SectionLabel>Account</SectionLabel>
        <Card style={{ paddingVertical: 12 }}>
          <Text style={styles.fieldLabel}>Your name</Text>
          <Text style={styles.fieldHint}>Shown in the alert so your circle knows who needs help.</Text>
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
            style={{ marginTop: 10, opacity: name.trim() ? 1 : 0.5 }}
          />
        </Card>
        <Card style={{ marginTop: 8, paddingVertical: 2 }}>
          <SRow label="Location" value={locOn ? 'On' : 'Off'} valueColor={locOn ? Beacon.safe : undefined} last />
        </Card>

        <SectionLabel>Safety</SectionLabel>
        <Card style={{ paddingVertical: 2 }}>
          <SRow label="Escalation" value="›" onPress={() => router.push('/escalation')} />
          <SRow label="Test your alert" value="›" onPress={() => router.push('/test-alert')} last />
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

        <Text style={styles.version}>Make It Home · v1.0.1</Text>
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
