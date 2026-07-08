import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder } from "react-native";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";

import { normalizeMetering, resampleWaveform } from "./waveform";

const MIN_RECORDING_MS = 500;
const CANCEL_THRESHOLD_PX = 80;
const METERING_INTERVAL_MS = 100;

export interface RecordedVoice {
  uri: string;
  durationMs: number;
  waveform: number[];
}

/**
 * Press-and-hold-to-record, slide-left-to-cancel, matching the swipe gesture
 * already used for reply-swipe on message bubbles. The PanResponder is
 * created once (via refs) so the touch responder chain survives the
 * idle->recording re-render; per-render-changing values (duration, the
 * onRecorded callback) are read through refs from inside the frozen handlers
 * instead of being captured at creation time.
 */
export function useVoiceRecorder(onRecorded: (voice: RecordedVoice) => void) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, METERING_INTERVAL_MS);

  const [isRecording, setIsRecording] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;
  const waveformRef = useRef<number[]>([]);
  const lastSampleAtRef = useRef(0);
  const durationRef = useRef(0);
  const onRecordedRef = useRef(onRecorded);

  durationRef.current = state.durationMillis;
  onRecordedRef.current = onRecorded;

  if (state.isRecording && typeof state.metering === "number") {
    const now = Date.now();
    if (now - lastSampleAtRef.current >= METERING_INTERVAL_MS - 20) {
      lastSampleAtRef.current = now;
      waveformRef.current.push(normalizeMetering(state.metering));
    }
  }

  const start = useRef(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    waveformRef.current = [];
    lastSampleAtRef.current = 0;
    translateX.setValue(0);
    setCancelArmed(false);
    await recorder.prepareToRecordAsync();
    recorder.record();
    setIsRecording(true);
  }).current;

  const finish = useRef(async (cancelled: boolean) => {
    setIsRecording(false);
    setCancelArmed(false);
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();

    const durationMs = durationRef.current;
    const uri = recorder.uri;
    try {
      await recorder.stop();
    } catch {
      // already stopped — nothing to clean up
    }
    await setAudioModeAsync({ allowsRecording: false });

    if (!cancelled && uri && durationMs >= MIN_RECORDING_MS) {
      onRecordedRef.current({ uri, durationMs, waveform: resampleWaveform(waveformRef.current) });
    }
  }).current;

  useEffect(
    () => () => {
      try {
        if (recorder.isRecording) {
          recorder.stop().catch(() => {});
        }
      } catch {
        // native recorder object may already be released by the time this
        // cleanup runs (unmount/Fast Refresh teardown ordering isn't guaranteed)
      }
    },
    [recorder]
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        void start();
      },
      onPanResponderMove: (_evt, gesture) => {
        const clamped = Math.min(0, gesture.dx);
        translateX.setValue(clamped);
        setCancelArmed(clamped < -CANCEL_THRESHOLD_PX);
      },
      onPanResponderRelease: (_evt, gesture) => {
        void finish(gesture.dx < -CANCEL_THRESHOLD_PX);
      },
      onPanResponderTerminate: () => {
        void finish(true);
      },
    })
  ).current;

  return {
    isRecording,
    durationMs: state.durationMillis,
    cancelArmed,
    translateX,
    panHandlers: panResponder.panHandlers,
  };
}
