import { Platform } from 'react-native';

// Clean-room synthesized ringtones (not the actual Apple/Google system tones,
// which apps cannot read or bundle). The default is chosen to match the
// platform so it feels native on each device.
export type RingtoneId = 'marimba' | 'classic' | 'digital' | 'chimes';

export interface Ringtone {
  id: RingtoneId;
  label: string;
  hint: string;
  source: number;
}

export const RINGTONES: Ringtone[] = [
  { id: 'marimba', label: 'Marimba', hint: 'iPhone-style', source: require('../assets/sounds/marimba.wav') },
  { id: 'classic', label: 'Classic phone', hint: 'Old-school ring', source: require('../assets/sounds/classic.wav') },
  { id: 'digital', label: 'Digital', hint: 'Android-style', source: require('../assets/sounds/digital.wav') },
  { id: 'chimes', label: 'Chimes', hint: 'Gentle bells', source: require('../assets/sounds/chimes.wav') },
];

export const DEFAULT_RINGTONE: RingtoneId = Platform.OS === 'android' ? 'digital' : 'marimba';

export function ringtoneSource(id: string | undefined | null): number {
  const found = RINGTONES.find(r => r.id === id);
  const fallback = RINGTONES.find(r => r.id === DEFAULT_RINGTONE) ?? RINGTONES[0];
  return (found ?? fallback).source;
}
