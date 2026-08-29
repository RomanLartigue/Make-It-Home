// Background audio capture for live sessions.
//
// iOS does NOT allow third-party apps to record camera VIDEO in the background —
// expo-camera stops its capture session the moment the app leaves the
// foreground. Audio, however, may keep recording (with the 'audio'
// UIBackgroundMode). So while a session is live we run an audio recorder that
// survives the phone locking / app-switching, giving evidence even when video
// can't continue. Video resumes when the app returns to the foreground.
//
// Uses expo-av (mature, SDK-54 bundled). Loaded lazily so its JS stays off the
// app launch path.

let recording: any = null;
let starting: Promise<boolean> | null = null;

/**
 * Ask for the mic permission while the app is in the FOREGROUND. Permission
 * prompts can't be shown once backgrounded — asking there just returns denied
 * (seen in the field as bg-audio-DENIED). Call at go-live.
 */
export async function warmUpBackgroundAudio(): Promise<void> {
  try {
    const { Audio } = await import('expo-av');
    await Audio.requestPermissionsAsync();
  } catch {
    // best-effort
  }
}

export async function startBackgroundAudio(): Promise<boolean> {
  if (recording) return true;
  if (starting) return starting;
  starting = (async () => {
    try {
      const { Audio } = await import('expo-av');
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) return false;
      // staysActiveInBackground + allowsRecordingIOS are what keep the mic alive
      // after the app is backgrounded (together with the 'audio' background mode).
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recording = rec;
      return true;
    } catch {
      return false;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** Stops the recorder and returns the audio file URI (or null). */
export async function stopBackgroundAudio(): Promise<string | null> {
  const rec = recording;
  recording = null;
  if (!rec) return null;
  try {
    await rec.stopAndUnloadAsync();
    const uri: string | null = rec.getURI?.() ?? null;
    // Release the audio session so it doesn't linger after the session ends.
    try {
      const { Audio } = await import('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, staysActiveInBackground: false });
    } catch {}
    return uri;
  } catch {
    return null;
  }
}

export function isBackgroundAudioActive(): boolean {
  return !!recording;
}

// ── Chunked live audio ────────────────────────────────────────────────────────
// Records rolling ~5s clips for the WHOLE session (foreground and background —
// the continuously-active recording is also what keeps iOS from suspending the
// app when it's backgrounded). Each finished clip is handed to onChunk for
// upload; the server stitches them into the one full-session audio at the end.
let chunkActive = false;
let chunkLoopDone: Promise<void> | null = null;

export async function startChunkedAudio(
  onChunk: (uri: string) => void,
  onError?: (msg: string) => void,
  chunkMs = 5000,
): Promise<boolean> {
  if (chunkActive) return true;
  try {
    const { Audio } = await import('expo-av');
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) {
      onError?.('mic permission denied');
      return false;
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    });
    chunkActive = true;
    let errored = false;
    chunkLoopDone = (async () => {
      while (chunkActive) {
        let rec: any = null;
        try {
          const r = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.LOW_QUALITY);
          rec = r.recording;
          errored = false;
        } catch (e: any) {
          // The camera may hold the mic exclusively on some devices — report
          // once, keep retrying (the camera releases it when backgrounded).
          if (!errored) {
            errored = true;
            onError?.(String(e?.message ?? e));
          }
          await new Promise(res => setTimeout(res, 2000));
          continue;
        }
        await new Promise(res => setTimeout(res, chunkMs));
        try {
          await rec.stopAndUnloadAsync();
          const uri: string | null = rec.getURI?.() ?? null;
          // Deliver even after stop was requested — the FINAL ~5s of a session
          // can be the most important seconds of the whole record.
          if (uri) onChunk(uri);
        } catch {
          // lost chunk — the next one starts immediately
        }
      }
      try {
        const { Audio: A } = await import('expo-av');
        await A.setAudioModeAsync({ allowsRecordingIOS: false, staysActiveInBackground: false });
      } catch {}
    })();
    return true;
  } catch (e: any) {
    onError?.(String(e?.message ?? e));
    return false;
  }
}

/**
 * Stops the chunk loop. Returns a promise resolving once the in-flight final
 * chunk has been stopped and handed to onChunk — await it before merging, so
 * the last clip makes it into the stitched session audio.
 */
export function stopChunkedAudio(): Promise<void> {
  chunkActive = false;
  return chunkLoopDone ?? Promise.resolve();
}
