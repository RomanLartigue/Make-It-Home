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
