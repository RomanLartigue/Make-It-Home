import { Alert, Platform } from 'react-native';

/**
 * Cross-platform confirmation dialog.
 *
 * `react-native-web` does not implement `Alert.alert`, so on the web build a
 * native `Alert` confirmation would silently do nothing. This falls back to the
 * browser's `window.confirm` on web and uses a real `Alert` on iOS/Android.
 */
export function confirmDestructive(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void,
) {
  if (Platform.OS === 'web') {
    const ok =
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`${title}\n\n${message}`)
        : true;
    if (ok) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
