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

const ACTIVE_SESSION_KEY = '@makeithome_active_session';
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
      const phones = JSON.parse(raw).map((c: any) => c.phone).filter(Boolean);
      if (phones.length) syncCircle(phones);
    })();
  }, []);

  // Clear a session left behind by a force-kill so the UI doesn't think one is
  // still live. (Foreground-only tracking, so nothing native to stop.)
  useEffect(() => {
    AsyncStorage.getItem(ACTIVE_SESSION_KEY).then(sessionId => {
      if (sessionId) AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    });
  }, []);

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
                <Stack.Screen name="fake-call" options={{ headerShown: false }} />
                <Stack.Screen
                  name="incoming-call"
                  options={{ headerShown: false, presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
                />
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
