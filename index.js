// App entry point — a thin, permanent safety net around expo-router's entry.
//
// In a Release build, React Native has no red-box: an uncaught JS error during
// startup is handed to native RCTExceptionsManager, which calls abort() — the app
// just dies with no message. This entry installs handlers BEFORE the app loads so
// a fatal startup error is SHOWN (and persisted for the next launch) instead of
// silently killing the app. Non-fatal errors are left alone.
//
// This is what let us find the original "no URL scheme" launch crash, and it
// stays in permanently so any future launch failure is visible, not a mystery.

import { AppRegistry, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LAST_ERROR_KEY = '@makeithome_last_startup_error';

function describe(error) {
  try {
    return {
      name: (error && error.name) || null,
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 4000) : null,
    };
  } catch (e) {
    return { name: null, message: 'describe() failed', stack: null };
  }
}

let shown = false;
function reportFatal(error, phase) {
  const d = describe(error);
  try {
    AsyncStorage.setItem(
      LAST_ERROR_KEY,
      JSON.stringify({ phase, ...d, at: new Date().toISOString() }),
    ).catch(() => {});
  } catch (e) {}
  if (!shown) {
    shown = true;
    try {
      Alert.alert(
        'Make It Home hit a startup error',
        (d.message || 'Unknown error') + '\n\n' + (d.stack || '').slice(0, 700),
      );
    } catch (e) {}
  }
}

// 1) Classic global handler (async / non-render errors).
function ourHandler(error, isFatal) {
  if (isFatal) reportFatal(error, 'globalHandler');
  // Non-fatal: swallow quietly (RN would only log these in dev anyway).
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
try {
  for (const ms of [0, 250, 500, 1000, 2000, 4000, 8000]) setTimeout(assertHandler, ms);
} catch (e) {}

// 2) React 19 routes RENDER-phase errors straight to ExceptionsManager.handleException,
//    bypassing ErrorUtils — hook it too so a first-render error can't reach abort().
try {
  const EM = require('react-native/Libraries/Core/ExceptionsManager');
  const patched = (error, isFatal) => {
    if (isFatal) reportFatal(error, 'render');
  };
  for (const t of [EM, EM && EM.default]) {
    if (t && typeof t.handleException === 'function') {
      try { t.handleException = patched; } catch (e) {}
    }
  }
} catch (e) {}

// 3) Belt-and-braces: neutralize the native fatal reporter itself.
try {
  const NEM = require('react-native/Libraries/Core/NativeExceptionsManager');
  const t = (NEM && (NEM.default || NEM)) || null;
  if (t) {
    if (typeof t.reportFatalException === 'function') {
      try {
        t.reportFatalException = (message, stack) =>
          reportFatal({ message, stack: JSON.stringify(stack || []).slice(0, 3000) }, 'nativeFatal');
      } catch (e) {}
    }
    if (typeof t.reportException === 'function') {
      try {
        const orig = t.reportException.bind(t);
        t.reportException = d => {
          if (d && d.isFatal) {
            reportFatal({ message: d.message, stack: JSON.stringify(d.stack || []).slice(0, 3000) }, 'nativeFatal');
          } else {
            try { orig(d); } catch (e) {}
          }
        };
      } catch (e) {}
    }
  }
} catch (e) {}

// Surface an error captured on a PREVIOUS launch (in case the alert didn't get
// a chance to render before the process ended).
try {
  AsyncStorage.getItem(LAST_ERROR_KEY)
    .then(raw => {
      if (!raw) return;
      AsyncStorage.removeItem(LAST_ERROR_KEY).catch(() => {});
      try {
        const p = JSON.parse(raw);
        Alert.alert('Previous launch error', (p.message || 'unknown') + '\n\n' + (p.stack || '').slice(0, 700));
      } catch (e) {}
    })
    .catch(() => {});
} catch (e) {}

// Load the real app. A synchronous throw while the app's modules evaluate is
// caught here and shown, with a minimal fallback screen so it isn't just black.
try {
  require('expo-router/entry');
} catch (error) {
  reportFatal(error, 'moduleEval');
  try {
    const React = require('react');
    const { Text, View } = require('react-native');
    const d = describe(error);
    const Fallback = () =>
      React.createElement(
        View,
        { style: { flex: 1, backgroundColor: '#0b1119', alignItems: 'center', justifyContent: 'center', padding: 24 } },
        React.createElement(
          Text,
          { style: { color: '#eaeef4', fontSize: 14, textAlign: 'center' } },
          'Make It Home could not start.\n\n' + (d.message || 'Unknown error'),
        ),
      );
    AppRegistry.registerComponent('main', () => Fallback);
  } catch (e2) {}
}
