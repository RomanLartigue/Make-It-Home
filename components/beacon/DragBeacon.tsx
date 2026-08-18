import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';

import { Beacon } from '@/constants/beacon';

const SIZE = 150;
const MAX_DRAG = 78;
const ARM_THRESHOLD = 46; // drag out this far to arm; release to confirm
const IS_WEB = Platform.OS === 'web';

/**
 * A hold-and-drag "joystick" beacon, matching the Home go-live control. Hold it,
 * drag out past the threshold (the button follows your thumb and turns armed),
 * then release to confirm. Release back near the center to cancel — so a stray
 * tap never fires. Keeps whatever icon you pass in the center.
 */
export function DragBeacon({
  icon,
  idleLabel,
  idleSub,
  armedLabel = 'Release',
  armedSub = 'to send',
  color = Beacon.beacon,
  armedColor = '#ff5238',
  onConfirm,
  disabled = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  idleLabel: string;
  idleSub: string;
  armedLabel?: string;
  armedSub?: string;
  color?: string;
  armedColor?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const xy = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const [armed, setArmed] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);

  // Idle breathing pulse (JS driver — the transform also carries xy, which must
  // be JS-driven; mixing drivers on one view throws).
  useEffect(() => {
    if (armed || disabled) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.06, duration: 1300, useNativeDriver: false, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(pulse, { toValue: 1, duration: 1300, useNativeDriver: false, easing: Easing.inOut(Easing.ease) }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [armed, disabled, pulse]);

  const gesture = useRef(
    Gesture.Pan()
      .runOnJS(true)
      .hitSlop(20)
      .onBegin(() => {
        setArmed(true);
        readyRef.current = false;
        setReady(false);
        if (!IS_WEB) Haptics.selectionAsync();
      })
      .onUpdate(e => {
        const dx = e.translationX;
        const dy = e.translationY;
        const dist = Math.hypot(dx, dy) || 1;
        const scale = dist > MAX_DRAG ? MAX_DRAG / dist : 1;
        xy.setValue({ x: dx * scale, y: dy * scale });
        const nowReady = dist >= ARM_THRESHOLD;
        if (nowReady !== readyRef.current) {
          readyRef.current = nowReady;
          setReady(nowReady);
          if (!IS_WEB) Haptics.selectionAsync();
        }
      })
      .onEnd(() => {
        if (readyRef.current) onConfirm();
      })
      .onFinalize(() => {
        setArmed(false);
        setReady(false);
        readyRef.current = false;
        Animated.spring(xy, { toValue: { x: 0, y: 0 }, useNativeDriver: false, bounciness: 8 }).start();
      }),
  ).current;

  return (
    <View style={styles.arena}>
      {armed && <View style={[styles.halo, ready && { borderColor: armedColor }]} pointerEvents="none" />}
      <GestureDetector gesture={disabled ? Gesture.Pan().enabled(false) : gesture}>
        <Animated.View
          style={[
            styles.beacon,
            { backgroundColor: ready ? armedColor : color },
            disabled && { opacity: 0.4 },
            { transform: [{ translateX: xy.x }, { translateY: xy.y }, { scale: armed ? 1 : pulse }] },
          ]}
        >
          <Ionicons name={icon} size={30} color="#fff" />
          <Text style={styles.label}>{armed ? armedLabel : idleLabel}</Text>
          <Text style={styles.sub}>{armed ? armedSub : idleSub}</Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  arena: { width: SIZE + MAX_DRAG * 2, height: SIZE + MAX_DRAG * 2, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  halo: {
    position: 'absolute',
    width: SIZE + 44,
    height: SIZE + 44,
    borderRadius: (SIZE + 44) / 2,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.18)',
    borderStyle: 'dashed',
  },
  beacon: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 12,
  },
  label: { color: '#fff', fontWeight: '800', fontSize: 17 },
  sub: { color: 'rgba(255,255,255,0.9)', fontWeight: '600', fontSize: 11 },
});
