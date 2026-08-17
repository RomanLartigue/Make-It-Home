import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Beacon } from '@/constants/beacon';

const THUMB = 54;
const PAD = 4;

/**
 * Slide-to-confirm control: drag the thumb to the far end to trigger a
 * deliberate, hard-to-do-by-accident action. Springs back if released short.
 */
export function SlideToConfirm({
  label = 'Slide to confirm',
  color = Beacon.beacon,
  icon = 'arrow-forward',
  onConfirm,
  disabled = false,
}: {
  label?: string;
  color?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [trackW, setTrackW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const confirmed = useRef(false);
  const maxX = Math.max(0, trackW - THUMB - PAD * 2);

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .onUpdate(e => {
      if (confirmed.current) return;
      x.setValue(Math.min(maxX, Math.max(0, e.translationX)));
    })
    .onEnd(e => {
      if (confirmed.current) return;
      const nx = Math.min(maxX, Math.max(0, e.translationX));
      if (maxX > 0 && nx >= maxX * 0.85) {
        confirmed.current = true;
        Animated.timing(x, { toValue: maxX, duration: 110, useNativeDriver: false }).start(() => {
          onConfirm();
        });
      } else {
        Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
      }
    })
    .runOnJS(true);

  const labelOpacity = x.interpolate({
    inputRange: [0, Math.max(1, maxX)],
    outputRange: [1, 0],
  });

  return (
    <View
      style={[styles.track, disabled && { opacity: 0.5 }]}
      onLayout={e => setTrackW(e.nativeEvent.layout.width)}
    >
      <Animated.Text style={[styles.label, { opacity: labelOpacity }]} numberOfLines={1}>
        {label}
      </Animated.Text>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.thumb, { backgroundColor: color, transform: [{ translateX: x }] }]}>
          <Ionicons name={icon} size={24} color="#fff" />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: THUMB + PAD * 2,
    borderRadius: (THUMB + PAD * 2) / 2,
    backgroundColor: Beacon.surface2,
    borderWidth: 1,
    borderColor: Beacon.line,
    justifyContent: 'center',
    paddingHorizontal: PAD,
    overflow: 'hidden',
  },
  label: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    color: Beacon.muted,
    fontSize: 14,
    fontWeight: '600',
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
