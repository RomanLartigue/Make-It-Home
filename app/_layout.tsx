import { ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';
import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

// Imported at root level so the background task is registered before any
// component uses it (importing the module runs its registration side effect).
import { BACKGROUND_LOCATION_TASK } from '@/tasks/backgroundLocation';

import { getDeviceToken } from '@/utils/serverUrl';
import { BeaconNavTheme } from '@/constants/theme';
import { Beacon } from '@/constants/beacon';

const ACTIVE_SESSION_KEY = '@makeithome_active_session';

export default function RootLayout() {
  // Pre-warm the per-device auth token so the first safety tap never stalls.
  useEffect(() => {
    getDeviceToken().catch(() => {});
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
  return (
    <SafeAreaProvider>
      <ThemeProvider value={BeaconNavTheme}>
        <Stack screenOptions={{ contentStyle: { backgroundColor: Beacon.night } }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="escalation" options={{ headerShown: false }} />
          <Stack.Screen name="legal" options={{ headerShown: false, presentation: 'modal' }} />
        </Stack>
        <StatusBar style="light" />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
