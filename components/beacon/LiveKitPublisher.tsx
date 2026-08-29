// Real-time broadcast (Gold): publishes the phone's camera + mic to a LiveKit
// room so the safety circle sees a true live video/audio stream — not snapshots.
// iOS pauses the camera when the app is backgrounded; the mic keeps publishing
// (FaceTime-style) via the 'audio' background mode, so sound continues.
//
// This screen REPLACES the expo-camera go-live view when a session runs in
// LiveKit mode. It owns only the camera/stream + End button; the alerting,
// location, escalation and heartbeat all still run in the parent (index.tsx).

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, AppState, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
// IMPORTANT: import @livekit/react-native FIRST. Its module sets up the required
// polyfills (DOMException, etc.) as a side effect on import; importing
// livekit-client before it throws "Property 'DOMException' doesn't exist" the
// moment livekit-client evaluates. Order matters here — do not reorder.
import {
  LiveKitRoom,
  useTracks,
  VideoTrack,
  registerGlobals,
  AudioSession,
} from '@livekit/react-native';
import { Track } from 'livekit-client';

import { Beacon } from '@/constants/beacon';
import { PillButton } from '@/components/beacon/kit';
import { hSuccess } from '@/utils/haptics';

// Must run before any LiveKit/WebRTC use. Idempotent; safe at module load.
registerGlobals();

function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Inner view (inside the room context): renders the local camera preview and the
// live status. Reports connection state up so the parent can trace it.
function BroadcastInner({
  elapsed,
  paused,
  alertState,
  overdue,
  ackByCircle,
  onEnd,
}: {
  elapsed: number;
  paused: boolean;
  alertState: 'ok' | 'sending' | 'failed';
  overdue: boolean;
  ackByCircle: boolean;
  onEnd: () => void;
}) {
  // The publisher's own camera track (published locally).
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const camera = tracks.find(t => t.participant?.isLocal);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const flippingRef = useRef(false);

  // Flip between back and front camera via LiveKit's restartTrack — the SDK
  // manages the capture, so the raw _switchCamera gets undone by a track
  // restart with the old constraints (looked like a "reset", not a flip).
  const flipCamera = async () => {
    if (flippingRef.current) return;
    flippingRef.current = true;
    try {
      const track: any = (camera?.publication as any)?.track;
      if (track?.restartTrack) {
        const next = facing === 'environment' ? 'user' : 'environment';
        await track.restartTrack({ facingMode: next });
        setFacing(next);
      }
    } catch {
      // no-op — flip is cosmetic, never break the stream
    } finally {
      flippingRef.current = false;
    }
  };
  const mirrored = facing === 'user'; // selfie preview mirrors, like the Camera app

  return (
    <View style={styles.root}>
      {camera && !paused ? (
        <VideoTrack trackRef={camera} style={styles.fill} objectFit="cover" mirror={mirrored} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.pausedCover]}>
          {paused ? (
            <>
              <Text style={styles.pausedTitle}>⏸ Camera paused</Text>
              <Text style={styles.pausedSub}>
                You left the app. Your circle still hears live audio and sees your location. Video resumes when you
                return.
              </Text>
            </>
          ) : (
            <Text style={styles.pausedSub}>Connecting live camera…</Text>
          )}
        </View>
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.recRow}>
          <View style={styles.recBadge}>
            <View style={[styles.recDot, paused && { backgroundColor: Beacon.warn }]} />
            <Text style={styles.recLabel}>{paused ? 'LIVE · AUDIO' : 'LIVE'}</Text>
          </View>
          <Text style={styles.recTimer}>{formatTime(elapsed)}</Text>
          <View style={{ flex: 1 }} />
          {!paused && (
            <Pressable style={styles.flipBtn} onPress={flipCamera} hitSlop={8}>
              <Ionicons name="camera-reverse-outline" size={20} color="#fff" />
            </Pressable>
          )}
        </View>
        <View style={styles.status}>
          {/* The alert to the circle must NEVER fail silently behind this screen. */}
          {overdue ? (
            <Text style={[styles.statusText, styles.statusBad]}>
              ⚠ Are you safe? Tap I&apos;m safe — your circle is being re-alerted
            </Text>
          ) : alertState === 'failed' ? (
            <Text style={[styles.statusText, styles.statusBad]}>⚠ Circle NOT alerted — see the message</Text>
          ) : alertState === 'sending' ? (
            <Text style={[styles.statusText, styles.statusWarn]}>Alerting your circle…</Text>
          ) : (
            <Text style={styles.statusText}>
              {paused ? 'Broadcasting audio + location…' : '✓ Circle alerted — streaming live'}
            </Text>
          )}
          {ackByCircle && (
            <Text style={[styles.statusText, styles.statusOk]}>🟢 Someone is on their way to you</Text>
          )}
        </View>
        <View style={styles.endWrap}>
          {/* "I'm safe" is THE stop: ends the stream, stops all alerts, and
              texts the circle "✅ <name> is safe." automatically. */}
          <PillButton title="I'm safe" kind={overdue ? 'primary' : 'dark'} onPress={onEnd} style={styles.endBtn} />
        </View>
      </SafeAreaView>
    </View>
  );
}

export function LiveKitPublisher({
  serverUrl,
  token,
  elapsed,
  alertState = 'sending',
  overdue = false,
  ackByCircle = false,
  onEnd,
  onConnected,
  onError,
}: {
  serverUrl: string;
  token: string;
  elapsed: number;
  alertState?: 'ok' | 'sending' | 'failed';
  overdue?: boolean;
  ackByCircle?: boolean;
  onEnd: () => void;
  onConnected?: () => void;
  onError?: (msg: string) => void;
}) {
  const [paused, setPaused] = useState(false);

  // Start the native audio session (needed for mic capture + background audio),
  // and tear it down on unmount.
  useEffect(() => {
    let mounted = true;
    AudioSession.startAudioSession()
      .then(() => {
        if (!mounted) AudioSession.stopAudioSession();
      })
      .catch(() => {});
    return () => {
      mounted = false;
      AudioSession.stopAudioSession().catch(() => {});
    };
  }, []);

  // Track background/foreground for the "camera paused" UI. LiveKit keeps the
  // mic publishing while backgrounded; the camera track goes black, so we show
  // the paused panel instead.
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => setPaused(s !== 'active'));
    return () => sub.remove();
  }, []);

  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect
      audio
      // Default to the BACK (world-facing) camera — this is evidence of the
      // surroundings, not a selfie. The flip button switches to front.
      video={{ facingMode: 'environment' }}
      onConnected={onConnected}
      onError={e => onError?.(String((e as any)?.message ?? e))}
      options={{ adaptiveStream: true, dynacast: true }}
    >
      <BroadcastInner
        elapsed={elapsed}
        paused={paused}
        alertState={alertState}
        overdue={overdue}
        ackByCircle={ackByCircle}
        onEnd={() => { hSuccess(); onEnd(); }}
      />
    </LiveKitRoom>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  fill: { ...StyleSheet.absoluteFillObject },
  pausedCover: { backgroundColor: 'rgba(6,8,12,0.94)', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 },
  pausedTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  pausedSub: { color: '#9aa4b2', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 20 },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  recBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#ff3b30' },
  recLabel: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  recTimer: {
    color: '#fff',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  status: { alignItems: 'center' },
  statusText: {
    color: '#fff',
    fontSize: 12.5,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  statusWarn: { color: '#fbbf24' },
  statusBad: { color: '#f87171', backgroundColor: 'rgba(80,10,10,0.75)' },
  statusOk: { color: '#4ade80', marginTop: 8 },
  flipBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  endWrap: { alignItems: 'center', marginBottom: 24 },
  endBtn: { width: 200 },
});
