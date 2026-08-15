// Custom entry point (diagnostic build).
//
// A Release build has no red-box: an uncaught JS launch error is reported to
// native RCTExceptionsManager which calls abort() — a silent hard crash (this is
// why the app runs in Expo Go but crashes on TestFlight). This entry captures
// the real error FOUR ways so we finally get its text:
//   1. On-screen Alert (works with no network and before any UI mounts)
//   2. AsyncStorage (survives the crash; alerted + reported on next launch)
//   3. POST to the server /clientlog (readable in Railway logs)
//   4. Re-asserts the global error handler repeatedly so nothing installed
//      later (expo, RN internals) can swap back the abort()-ing default.

import { AppRegistry, Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ||
  'https://make-it-home-server-production.up.railway.app';

const LAST_ERROR_KEY = '@makeithome_last_startup_error';

function describe(error) {
  try {
    return {
      name: (error && error.name) || null,
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 6000) : null,
    };
  } catch (e) {
    return { name: null, message: 'describe() failed', stack: null };
  }
}

function report(error, isFatal, phase) {
  const d = describe(error);
  // 1) Persist first — survives even if we crash right after.
  try {
    AsyncStorage.setItem(
      LAST_ERROR_KEY,
      JSON.stringify({ phase, isFatal: !!isFatal, ...d, at: new Date().toISOString() }),
    ).catch(() => {});
  } catch (e) {}
  // 2) Ship to server logs.
  try {
    fetch(SERVER_URL + '/clientlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase, isFatal: !!isFatal, platform: Platform.OS, ...d }),
    }).catch(() => {});
  } catch (e) {}
  // 3) Show on screen — needs no network, no mounted UI.
  try {
    Alert.alert('Startup error (' + phase + ')', (d.message || 'unknown') + '\n\n' + (d.stack || '').slice(0, 800));
  } catch (e) {}
}

// Our handler swallows fatals (no abort) so the report can be seen/sent.
function ourHandler(error, isFatal) {
  report(error, isFatal, 'globalHandler');
}

function assertHandler() {
  try {
    const g = global;
    if (g.ErrorUtils && typeof g.ErrorUtils.setGlobalHandler === 'function') {
      if (g.ErrorUtils.getGlobalHandler && g.ErrorUtils.getGlobalHandler() === ourHandler) return;
      g.ErrorUtils.setGlobalHandler(ourHandler);
    }
  } catch (e) {}
}

assertHandler();
// Something later in startup may replace the handler with the abort()-ing
// default — keep taking it back during the launch window.
try {
  const delays = [0, 250, 500, 1000, 2000, 4000, 8000, 15000];
  for (const ms of delays) setTimeout(assertHandler, ms);
} catch (e) {}

// Surface (and report) an error captured on a PREVIOUS launch.
try {
  AsyncStorage.getItem(LAST_ERROR_KEY)
    .then(raw => {
      if (!raw) return;
      AsyncStorage.removeItem(LAST_ERROR_KEY).catch(() => {});
      try {
        fetch(SERVER_URL + '/clientlog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: raw.startsWith('{')
            ? raw.slice(0, -1) + ',"phase":"previousLaunch"}'
            : JSON.stringify({ phase: 'previousLaunch', message: raw }),
        }).catch(() => {});
      } catch (e) {}
      try {
        const p = JSON.parse(raw);
        Alert.alert('Previous launch error', (p.message || 'unknown') + '\n\n' + (p.stack || '').slice(0, 800));
      } catch (e) {}
    })
    .catch(() => {});
} catch (e) {}

// Catch synchronous errors thrown while the app's modules evaluate.
try {
  require('expo-router/entry');
} catch (error) {
  report(error, true, 'moduleEval');
  try {
    const React = require('react');
    const { Text, View } = require('react-native');
    const d = describe(error);
    const Fallback = () =>
      React.createElement(
        View,
        { style: { flex: 1, backgroundColor: '#0b0f14', alignItems: 'center', justifyContent: 'center', padding: 24 } },
        React.createElement(
          Text,
          { style: { color: '#e6edf3', fontSize: 14, textAlign: 'center' } },
          'Startup error logged.\n\n' + (d.message || 'unknown'),
        ),
      );
    AppRegistry.registerComponent('main', () => Fallback);
  } catch (e2) {}
}
