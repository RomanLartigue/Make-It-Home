// Escalation ladder — shared between the escalation editor and the go-live flow.
//
// Contacts in the safety circle each carry a `tier` id. On go-live the app sends
// the circle grouped by tier; the server alerts the first tier immediately and
// climbs to each later tier only if no one has acknowledged within its wait.

export const ESCALATION_TIERS_KEY = '@makeithome_escalation_tiers';

export interface Tier {
  id: string;
  name: string;
  /** Minutes to wait after the previous tier is alerted (with no ack) before
   *  this tier is alerted. Ignored for the first tier (alerted immediately). */
  waitMinutes: number;
}

export const DEFAULT_TIERS: Tier[] = [
  { id: 't1', name: 'First responders', waitMinutes: 0 },
  { id: 't2', name: 'Second responders', waitMinutes: 5 },
];

export const WAIT_OPTIONS = [2, 3, 5, 10, 15, 20];

/** A contact's tier id, coerced to a tier that actually exists (else the first). */
export function tierIdFor(contactTier: string | undefined | null, tiers: Tier[]): string {
  return tiers.some(t => t.id === contactTier) ? (contactTier as string) : tiers[0].id;
}

/** Next default name when adding a tier ("Third responders", "Fourth…", …). */
export function nextTierName(count: number): string {
  const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
  const word = ordinals[count] ?? `Tier ${count + 1}`;
  return `${word} responders`;
}
