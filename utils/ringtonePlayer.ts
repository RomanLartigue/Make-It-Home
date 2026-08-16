// Ringtone player for the Fake Call feature.
//
// TEMPORARY: audio is disabled. expo-audio was the only native module added
// between the last launching TestFlight build (8) and the builds that crash at
// launch (9–11); it is removed while we confirm it is the cause. The fake call
// still rings via vibration and the full-screen call UI. Sound returns once the
// launch crash is confirmed fixed (via a module that is verified safe on the
// launch path).
//
// The interface is kept so callers don't change when audio comes back.

export interface RingtonePlayer {
  playLooping(): void;
  playOnce(): void;
  stop(): void;
  replace(source: number): void;
  release(): void;
}

const NOOP_PLAYER: RingtonePlayer = {
  playLooping() {},
  playOnce() {},
  stop() {},
  replace() {},
  release() {},
};

export async function createRingtonePlayer(_source: number): Promise<RingtonePlayer> {
  return NOOP_PLAYER;
}
