// Lazy ringtone player.
//
// expo-audio's JS touches its native module the moment it is IMPORTED
// (it patches AudioModule.AudioPlayer.prototype at module top level). Because
// expo-router evaluates every route file at app launch, a plain
// `import ... from 'expo-audio'` in any screen puts audio initialization on the
// launch path — which crashed the standalone Release build (works in Expo Go,
// where the module is always present and warm).
//
// This module loads expo-audio with a dynamic import(), so it is only pulled in
// when a ringtone is actually needed (Fake Call screens), never at startup.

export interface RingtonePlayer {
  /** Play the loaded source on a loop at full volume. */
  playLooping(): void;
  /** Play the loaded source once (for previews). */
  playOnce(): void;
  /** Stop playback (pause + rewind). */
  stop(): void;
  /** Swap the loaded source (for previews that cycle ringtones). */
  replace(source: number): void;
  /** Free the native player. */
  release(): void;
}

let audioModePromise: Promise<void> | null = null;

async function loadExpoAudio() {
  // Dynamic import keeps expo-audio out of the launch bundle-evaluation path.
  return import('expo-audio');
}

async function ensureAudioMode(mod: typeof import('expo-audio')) {
  if (!audioModePromise) {
    audioModePromise = mod
      .setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false })
      .catch(() => {});
  }
  return audioModePromise;
}

export async function createRingtonePlayer(source: number): Promise<RingtonePlayer> {
  const mod = await loadExpoAudio();
  await ensureAudioMode(mod);
  const player = mod.createAudioPlayer(source);

  return {
    playLooping() {
      try {
        player.loop = true;
        player.volume = 1.0;
        player.play();
      } catch {}
    },
    playOnce() {
      try {
        player.loop = false;
        player.volume = 1.0;
        player.seekTo(0).catch(() => {});
        player.play();
      } catch {}
    },
    stop() {
      try {
        player.pause();
        player.seekTo(0).catch(() => {});
      } catch {}
    },
    replace(next: number) {
      try {
        player.replace(next);
      } catch {}
    },
    release() {
      try {
        player.remove();
      } catch {}
    },
  };
}
