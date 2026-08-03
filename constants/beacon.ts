/**
 * Beacon design tokens — the dark "beacon" visual language ported from the
 * phase-1 prototype (see /prototype). Every screen pulls its colors, spacing,
 * and radii from here so the app stays visually consistent.
 */

export const Beacon = {
  // Surfaces
  night: '#0b1119',
  nightBottom: '#080d14',
  surface: '#141d29',
  surface2: '#1b2734',
  line: '#27333f',

  // Text
  text: '#eaeef4',
  muted: '#8b96a8',
  faint: '#5c6675',

  // Accents
  beacon: '#ff6a4d',
  beaconLight: '#ff7a5a',
  beaconDeep: '#e14e33',
  hot: '#ff3b30',
  safe: '#4bd6a6',
  warn: '#ffc24d',
  amber: '#ffb020',
  info: '#5aa2ff',
} as const;

// Avatar background rotation for circle members
export const AVATAR_COLORS = [
  '#3b6ea5',
  '#8a5cc4',
  '#c47a3d',
  '#3ca08a',
  '#4d7ea8',
  '#b6567f',
];

export const RADIUS = {
  card: 16,
  pill: 999,
  field: 14,
  sheet: 22,
};

/** Two-letter initials from a name, e.g. "Alex Kim" -> "AK". */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map(w => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}
