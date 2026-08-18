// Make It Home Gold — entitlement.
//
// One paid tier: Gold Individual ($4.99/mo) or Gold Family (up to 5, $9.99/mo),
// monthly or yearly. Gold only ADDS features; the free core is never gated.
//
// Gold unlocks exactly three things:
//   1. Custom escalation times (free = fixed +5/+10/+15 re-notification schedule)
//   2. Cloud recording history (free = phone + 24h download link)
//   3. Local safety stats (nearest police / hospital / fire station)
//
// TODAY the flag is a local, dev-toggleable value so the features can be built
// and tested. The real source of truth will be an in-app purchase (RevenueCat)
// verified server-side, and this module is the single seam that swaps in.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const GOLD_KEY = '@makeithome_gold';

export const GOLD_PRICING = {
  individual: { monthly: 4.99, yearly: 39.99 },
  family: { monthly: 9.99, yearly: 79.99 },
} as const;

let cached: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();

export async function isGold(): Promise<boolean> {
  if (cached !== null) return cached;
  const v = await AsyncStorage.getItem(GOLD_KEY).catch(() => null);
  cached = v === 'true';
  return cached;
}

/** Dev/testing toggle. Replaced by the purchase flow later. */
export async function setGold(value: boolean): Promise<void> {
  cached = value;
  await AsyncStorage.setItem(GOLD_KEY, value ? 'true' : 'false').catch(() => {});
  listeners.forEach(l => l(value));
}

/** React hook: current Gold status, live-updating. */
export function useGold(): boolean {
  const [gold, setGoldState] = useState<boolean>(cached ?? false);
  useEffect(() => {
    let alive = true;
    isGold().then(v => alive && setGoldState(v));
    const l = (v: boolean) => alive && setGoldState(v);
    listeners.add(l);
    return () => {
      alive = false;
      listeners.delete(l);
    };
  }, []);
  return gold;
}
