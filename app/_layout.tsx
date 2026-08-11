import { ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, StyleSheet, Platform } from 'react-native';
import 'react-native-gesture-handler';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

// Imported at root level so the background task is registered before any
// component uses it (importing the module runs its registration side effect).
import { BACKGROUND_LOCATION_TASK } from '@/tasks/backgroundLocation';

import { getDeviceToken, syncCircle } from '@/utils/serverUrl';
import { BeaconNavTheme } from '@/constants/theme';
import { Beacon } from '@/constants/beacon';

const ACTIVE_SESSION_KEY = '@makeithome_active_session';
const SAFETY_CIRCLE_KEY = '@makeithome_safety_circle';

export default function RootLayout() {
  // Pre-warm the per-device auth token so the first safety tap never stalls,
  // then push the stored safety circle to the server. The server only sends
  // alerts to a device's synced circle, so this must happen before a go-live —
  // it covers installs whose circle predates server-side circle storage.
  useEffect(() => {
    (async () => {
      await getDeviceToken().catch(() => {});
      const raw = await AsyncStorage.getItem(SAFETY_CIRCLE_KEY);
      if (!raw) return;
      const phones = JSON.parse(raw).map((c: any) => c.phone).filter(Boolean);
      if (phones.length) syncCircle(phones);
    })();
  }, []);

  // Clean up any session that was orphaned by a force-kill
  useEffect(() => {
    AsyncStorage.getItem(ACTIVE_SESSION_KEY).then(async sessionId => {
      if (!sessionId) return;
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {});
      await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
      console.log('[launch] Cleared stale session:', sessionId);
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
