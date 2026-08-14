// MUST be first — installs the global error trap before anything else can throw.
import { getTrappedError, subscribeTrappedError } from '@/utils/errorTrap';
import * as Sentry from '@sentry/react-native';

import { ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import 'react-native-gesture-handler';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getDeviceToken, syncCircle } from '@/utils/serverUrl';
import { BeaconNavTheme } from '@/constants/theme';
import { Beacon } from '@/constants/beacon';

const SAFETY_CIRCLE_KEY = '@makeithome_safety_circle';

// Initialize crash reporting as early as possible so it captures the launch
// crash. sentry-cocoa installs native signal/exception handlers here, which
// catch native crashes independently of any JS handler.
Sentry.init({
  dsn: 'https://cba9cfa4ae09f158b04a08492fa8b44c@o4511910476316672.ingest.us.sentry.io/4511910508494848',
  enableNativeCrashHandling: true,
  attachStacktrace: true,
  tracesSampleRate: 0,
  debug: false,
});

// Full-screen error readout used by both the router error boundary and the
// global trap below. Puts the actual message + stack on screen so a release
// crash can be read/screenshotted instead of aborting silently.
function ErrorScreen({ message, stack }: { message: string; stack?: string }) {
  return (
    <View style={styles.errRoot}>
      <ScrollView contentContainerStyle={styles.errScroll}>
        <Text style={styles.errTitle}>Make It Home hit an error</Text>
        <Text style={styles.errMsg}>{message}</Text>
        {!!stack && <Text style={styles.errStack}>{stack}</Text>}
      </ScrollView>
    </View>
  );
}

// expo-router renders this when a *route* throws during render.
export function ErrorBoundary({ error }: { error: Error }) {
  return <ErrorScreen message={String(error?.message ?? error)} stack={error?.stack} />;
}

function RootLayout() {
  // Surfaces errors thrown at launch (module load / async) that a React error
  // boundary can't catch — the global trap captures them, we render them here.
  const [trapped, setTrapped] = useState<string | null>(getTrappedError());
  useEffect(() => {
    const off = subscribeTrappedError(setTrapped);
    setTrapped(getTrappedError());
    return off;
  }, []);

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

  // If something threw during launch, show it instead of a blank/crashed screen.
  if (trapped) {
    const [firstLine, ...rest] = trapped.split('\n\n');
    return <ErrorScreen message={firstLine} stack={rest.join('\n\n')} />;
  }

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

export default Sentry.wrap(RootLayout);

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
  errRoot: { flex: 1, backgroundColor: '#0a0a0a' },
  errScroll: { padding: 24, paddingTop: 80 },
  errTitle: { color: '#fff', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  errMsg: { color: '#ff8a6e', fontSize: 14, marginBottom: 16 },
  errStack: { color: '#8a8a8a', fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
});
