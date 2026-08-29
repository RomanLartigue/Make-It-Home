// Central haptics. One place to tune the whole app's "feel" — the beacons and
// buttons were too subtle, so the defaults here are deliberately firm (Medium/
// Heavy impacts, not the featherweight selection tick). All are no-ops on web
// and swallow errors (a device without a Taptic Engine must never throw).

import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

const ON = Platform.OS !== 'web';

/** Light-but-noticeable tick for incremental changes (dragging across a step). */
export function hTick() {
  if (ON) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Standard button/tap press — the default for any tappable control. */
export function hTap() {
  if (ON) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Sharper tick used when arming / crossing a selection threshold. */
export function hArm() {
  if (ON) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
}

/**
 * A firm double-thump for COMMITTING the important gestures (go-live, send test,
 * confirm). Two heavy impacts back-to-back read as decisive — a single tap felt
 * too light to signal "this just happened".
 */
export function hConfirm() {
  if (!ON) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
  setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {}), 80);
}

export function hSuccess() {
  if (ON) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

export function hWarning() {
  if (ON) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

export function hError() {
  if (ON) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}
