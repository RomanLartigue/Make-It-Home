/**
 * Beacon UI kit — small, reusable primitives shared across every screen so the
 * dark "beacon" look stays consistent. Pure presentational components; no
 * business logic lives here.
 */
import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  ViewStyle,
  StyleProp,
  TextStyle,
} from 'react-native';
import { Beacon, RADIUS } from '@/constants/beacon';

/** Rounded surface card. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Small colored status dot with a soft halo. */
export function Pip({ color = Beacon.safe, halo = true }: { color?: string; halo?: boolean }) {
  return (
    <View
      style={[
        styles.pip,
        { backgroundColor: color },
        halo && { shadowColor: color, shadowOpacity: 0.6, shadowRadius: 6, elevation: 3 },
      ]}
    />
  );
}

/** Uppercase section label. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.secLabel}>{children}</Text>;
}

/**
 * A settings-style row: a left label and an optional right value / control.
 * Tappable when onPress is provided.
 */
export function SRow({
  label,
  value,
  valueColor,
  right,
  onPress,
  danger,
  last,
}: {
  label?: React.ReactNode;
  value?: React.ReactNode;
  valueColor?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  const body = (
    <View style={[styles.srow, last && { borderBottomWidth: 0 }]}>
      {typeof label === 'string' ? (
        <Text style={[styles.srowLabel, danger && styles.danger]}>{label}</Text>
      ) : (
        label
      )}
      {right !== undefined
        ? right
        : value !== undefined && (
            <Text style={[styles.srowVal, valueColor ? { color: valueColor } : null]}>
              {value}
            </Text>
          )}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}>
        {body}
      </Pressable>
    );
  }
  return body;
}

/** Animated on/off toggle. Controlled via `value`. */
export function Toggle({ value, onToggle }: { value: boolean; onToggle?: () => void }) {
  const anim = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  React.useEffect(() => {
    Animated.timing(anim, { toValue: value ? 1 : 0, duration: 180, useNativeDriver: false }).start();
  }, [value, anim]);
  const left = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 19] });
  const bg = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [Beacon.line, Beacon.safe],
  });
  return (
    <Pressable onPress={onToggle} hitSlop={8}>
      <Animated.View style={[styles.tgl, { backgroundColor: bg }]}>
        <Animated.View style={[styles.tglKnob, { left }]} />
      </Animated.View>
    </Pressable>
  );
}

type BtnKind = 'primary' | 'ghost' | 'dark';
export function PillButton({
  title,
  onPress,
  kind = 'primary',
  style,
  textStyle,
}: {
  title: string;
  onPress?: () => void;
  kind?: BtnKind;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const bg =
    kind === 'primary' ? Beacon.beacon : kind === 'dark' ? Beacon.surface2 : Beacon.surface;
  const border = kind === 'primary' ? Beacon.beacon : Beacon.line;
  const color = '#fff';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: bg, borderColor: border },
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      <Text style={[styles.pillText, { color }, textStyle]}>{title}</Text>
    </Pressable>
  );
}

/** Detail-screen header with a back chevron and title. */
export function DetailHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={styles.detailHead}>
      {onBack && (
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={8}>
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
      )}
      <Text style={styles.detailTitle}>{title}</Text>
    </View>
  );
}

/** Blue informational callout. */
export function Callout({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.callout}>
      <Text style={styles.calloutText}>{children}</Text>
    </View>
  );
}

/** Red warning note. */
export function WarnNote({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.warnNote}>
      <Text style={styles.warnText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    borderRadius: RADIUS.card,
    paddingHorizontal: 14,
  },
  pip: { width: 9, height: 9, borderRadius: 5 },
  secLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: Beacon.faint,
    marginTop: 16,
    marginBottom: 2,
  },
  srow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Beacon.line,
  },
  srowLabel: { fontSize: 14, color: Beacon.text, flexShrink: 1, paddingRight: 10 },
  srowVal: { fontSize: 13, color: Beacon.muted },
  danger: { color: '#ff7a6e', fontWeight: '700' },
  tgl: { width: 40, height: 23, borderRadius: 12, justifyContent: 'center' },
  tglKnob: {
    position: 'absolute',
    top: 2,
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: '#fff',
  },
  pill: {
    width: '100%',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
  },
  pillText: { fontWeight: '700', fontSize: 14 },
  detailHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8 },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: Beacon.surface,
    borderWidth: 1,
    borderColor: Beacon.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backChevron: { color: Beacon.muted, fontSize: 22, lineHeight: 24, marginTop: -2 },
  detailTitle: { fontWeight: '800', fontSize: 16, color: Beacon.text },
  callout: {
    backgroundColor: 'rgba(90,162,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(90,162,255,0.28)',
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginTop: 12,
  },
  calloutText: { fontSize: 12, color: '#bcd2f5', lineHeight: 18 },
  warnNote: {
    backgroundColor: 'rgba(255,90,80,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,90,80,0.3)',
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    marginTop: 12,
  },
  warnText: { fontSize: 12, color: '#ffbcb8', lineHeight: 18 },
});
