// Ringtone player for the Fake Call feature, backed by expo-av.
//
// History: this started on expo-audio, which crashed the Release build at launch
// on iOS 26 (its native init runs at startup regardless of JS). We switched to
// expo-av 16.0.8 — the mature, officially SDK-54-bundled audio library, a wholly
// different native codebase — and load it via a dynamic import() so its JS stays
// off the launch bundle-eval path.
//
// If a future change ever puts audio back on the crash path, the permanent
// startup safety net (index.js) will surface the error instead of a silent abort.

export interface RingtonePlayer {
  /** Play on a loop at full volume (incoming-call ringing). */
  playLooping(): void;
  /** Play once from the start (setup-screen preview). */
  playOnce(): void;
  /** Stop playback. */
  stop(): void;
  /** Unload the native sound. */
  release(): void;
}

const NOOP: RingtonePlayer = {
  playLooping() {},
  playOnce() {},
  stop() {},
  release() {},
};

let audioModePromise: Promise<void> | null = null;

async function ensureAudioMode(Audio: typeof import('expo-av').Audio) {
  if (!audioModePromise) {
    // Partial mode is merged with valid defaults by expo-av, so this won't throw.
    audioModePromise = Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false })
      .catch(() => {});
  }
  return audioModePromise;
}

export async function createRingtonePlayer(source: number): Promise<RingtonePlayer> {
  try {
    const { Audio } = await import('expo-av');
    await ensureAudioMode(Audio);
    const { sound } = await Audio.Sound.createAsync(source, { volume: 1.0 });
    return {
      playLooping() {
        sound.setIsLoopingAsync(true).then(() => sound.replayAsync()).catch(() => {});
      },
      playOnce() {
        sound.setIsLoopingAsync(false).then(() => sound.replayAsync()).catch(() => {});
      },
      stop() {
        sound.stopAsync().catch(() => {});
      },
      release() {
        sound.unloadAsync().catch(() => {});
      },
    };
  } catch {
    // Audio unavailable — caller falls back to vibration-only; never throw.
    return NOOP;
  }
}
