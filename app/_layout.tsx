import { ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, StyleSheet, Platform } from 'react-native';
import 'react-native-gesture-handler';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getDeviceToken, syncCircle } from '@/utils/serverUrl';
import { BeaconNavTheme } from '@/constants/theme';
import { Beacon } from '@/constants/beacon';
// Registers the background-location task at launch (TaskManager.defineTask must
// run at module top level before iOS delivers any background fix). Native, but
// only registers a handler — it starts nothing until a session goes live.
import '@/tasks/backgroundLocation';

const SAFETY_CIRCLE_KEY = '@makeithome_safety_circle';

export default function RootLayout() {
  // Pre-warm the per-device auth token so the first safety tap never stalls,
  // then push the stored safety circle to the server. The server only sends
  // alerts to a device's synced circle, so this must happen before a go-live.
  useEffect(() => {
    (async () => {
      await getDeviceToken().catch(() => {});
      const raw = await AsyncStorage.getItem(SAFETY_CIRCLE_KEY);
      if (!raw) return;
      // Guard the parse: one corrupt value must not silently kill circle sync
      // (the server only texts a device's synced circle).
      let phones: string[] = [];
      try {
        const parsed = JSON.parse(raw);
        phones = Array.isArray(parsed) ? parsed.map((c: any) => c?.phone).filter(Boolean) : [];
      } catch {
        phones = [];
      }
      if (phones.length) syncCircle(phones);
    })();
  }, []);

  // NOTE: a session left behind by a force-kill is cleaned up by the Home
  // screen's resume effect (app/(tabs)/index.tsx) — it must end the server
  // session and stop the background-location task, not just drop the key, so
  // the cleanup lives there and is NOT duplicated here.

  // Make It Home is a dark-only "beacon" experience — no light variant.
  // On web we constrain the app to a centered phone-width column so it doesn't
  // stretch edge-to-edge on a desktop monitor (native fills the screen as usual).
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={BeaconNavTheme}>
          <View style={styles.frame}>
            <View style={styles.inner}>
              <Stack screenOptions={{ contentStyle: { backgroundColor: Beacon.night } }}>
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="onboarding" options={{ headerShown: false }} />
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="escalation" options={{ headerShown: false }} />
                <Stack.Screen name="test-alert" options={{ headerShown: false }} />
                <Stack.Screen name="gold-plans" options={{ headerShown: false }} />
                <Stack.Screen name="guide" options={{ headerShown: false }} />
                <Stack.Screen name="history" options={{ headerShown: false }} />
                <Stack.Screen name="nearby" options={{ headerShown: false }} />
                <Stack.Screen name="legal" options={{ headerShown: false, presentation: 'modal' }} />
              </Stack>
            </View>
          </View>
          <StatusBar style="light" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    backgroundColor: Beacon.night,
    // Center the app horizontally on web/large screens.
    ...Platform.select({ web: { alignItems: 'center' }, default: {} }),
  },
  inner: {
    flex: 1,
    width: '100%',
    // Phone-width cap on web; unconstrained on native.
    ...Platform.select({ web: { maxWidth: 440 }, default: {} }),
  },
});
