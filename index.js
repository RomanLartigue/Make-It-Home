// Custom entry point (diagnostic).
//
// A Release build has no red-box: any uncaught JS error at launch is handed to
// native RCTExceptionsManager, which calls abort() — a hard crash with no visible
// message (this is why the app runs in Expo Go but crashes on TestFlight).
//
// This entry installs an error reporter BEFORE loading the app, so a startup
// error is POSTed to the server (readable in the logs) instead of vanishing.
// It also swallows the error rather than re-throwing, keeping the process alive
// long enough for the network request to complete.

import { AppRegistry, Platform } from 'react-native';

const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ||
  'https://make-it-home-server-production.up.railway.app';

function reportStartupError(error, isFatal, phase) {
  try {
    const payload = {
      phase: phase || 'runtime',
      isFatal: !!isFatal,
      name: (error && error.name) || null,
      message: (error && error.message) ? error.message : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 6000) : null,
      platform: Platform.OS,
    };
    fetch(SERVER_URL + '/clientlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (e) {
    // never let the reporter itself throw
  }
}

// 1) Catch async / render-time uncaught errors (these route through ErrorUtils).
try {
  const g = global;
  if (g.ErrorUtils && typeof g.ErrorUtils.setGlobalHandler === 'function') {
    g.ErrorUtils.setGlobalHandler((error, isFatal) => {
      reportStartupError(error, isFatal, 'globalHandler');
      // Intentionally do NOT call the previous handler (which would abort()),
      // so the report can be sent. Diagnostic build only.
    });
  }
} catch (e) {
  // ignore
}

// 2) Catch synchronous errors thrown while the app's modules evaluate.
try {
  require('expo-router/entry');
} catch (error) {
  reportStartupError(error, true, 'moduleEval');
  // Register a minimal fallback UI so the screen isn't just black and the user
  // can confirm the error was logged.
  try {
    const React = require('react');
    const { Text, View } = require('react-native');
    const Fallback = () =>
      React.createElement(
        View,
        { style: { flex: 1, backgroundColor: '#0b0f14', alignItems: 'center', justifyContent: 'center', padding: 24 } },
        React.createElement(
          Text,
          { style: { color: '#e6edf3', fontSize: 14, textAlign: 'center' } },
          'Startup error logged.\n\n' + ((error && error.message) || String(error)),
        ),
      );
    AppRegistry.registerComponent('main', () => Fallback);
  } catch (e2) {
    // ignore
  }
}
