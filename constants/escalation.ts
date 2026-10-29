// Escalation ladder — RE-NOTIFICATION model.
//
// A "round" is not a group of people; it's another alert to the WHOLE safety
// circle. When you go live, everyone is alerted immediately, then re-alerted
// on the schedule, then every 5 minutes forever once the slide time has fully
// passed. ONLY the user stops alerts, by marking themselves safe — a
// responder's "I'm on my way" is informational and never halts the ladder.
//
// Free users get the thirds-of-the-slider schedule; Gold customizes the
// intervals and how many rounds (see makeithome-monetization-plan).

export const ESCALATION_SCHEDULE_KEY = '@makeithome_escalation_schedule';

// Minutes to wait before each re-notification, measured from the previous text.
// Free default: +5 min, then +10, then +15.
export const DEFAULT_SCHEDULE: number[] = [5, 10, 15];

// Options a paid user can pick per round (minutes).
export const WAIT_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30];

// Free tier is capped at this many re-notification rounds.
export const MAX_FREE_ROUNDS = 3;

/** Normalize a stored schedule to a safe array of positive minute waits. */
export function normalizeSchedule(raw: unknown): number[] {
  if (!Array.isArray(raw)) return DEFAULT_SCHEDULE;
  const nums = raw
    .map(n => Math.round(Number(n)))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 120);
  return nums.length ? nums : DEFAULT_SCHEDULE;
}
