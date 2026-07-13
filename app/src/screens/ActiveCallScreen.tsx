import { useEffect, useRef, useState, type ComponentType, type Ref } from "react";
import { Alert, findNodeHandle, NativeModules, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { RTCView, ScreenCapturePickerView } from "react-native-webrtc";

import ExpoCallPip from "../../modules/expo-call-pip";
import { useCall } from "../calls/CallContext";
import { statusText } from "../calls/callFormat";
import { navigationRef } from "../navigation/navigationRef";
import Avatar from "../components/Avatar";

// iOS-only: react-native-webrtc's ScreenCapturePickerView is a hidden native
// view wrapping ReplayKit's RPSystemBroadcastPickerView — showing it (via
// this manager, keyed by the view's node handle, not a ref method) simulates
// a tap on its button, which pops the system "Start Broadcast" sheet for our
// Broadcast Upload Extension (see ios/BeaconScreenShare and
// docs/ios-screen-share-setup.md). Android needs no such picker: its
// MediaProjection permission prompt is triggered directly by
// getDisplayMedia() itself.
const { ScreenCapturePickerViewManager } = NativeModules;
// react-native-webrtc types this as HostComponent<unknown> (no declared
// props at all) since it's a bare requireNativeComponent with no JS-side
// prop typings — cast so it can take a ref and a style like any other view.
const TypedScreenCapturePickerView = ScreenCapturePickerView as unknown as ComponentType<{
  ref?: Ref<unknown>;
  style?: object;
}>;

// A typical portrait-ish call view aspect ratio for the floating PiP window;
// react-native-webrtc doesn't surface live track dimensions to this screen,
// so this is a reasonable fixed default rather than the exact video size.
const PIP_ASPECT_RATIO = { width: 9, height: 16 };

// Same fixed-dark treatment as IncomingCallScreen — call UI stays dark
// regardless of the app's light/dark setting.
const palette = {
  background: "#0B0B10",
  text: "#FFFFFF",
  textSecondary: "rgba(255,255,255,0.65)",
  controlIdle: "rgba(255,255,255,0.16)",
  controlActive: "#FFFFFF",
  end: "#FF3B30",
};

export default function ActiveCallScreen() {
  const insets = useSafeAreaInsets();
  const {
    call,
    phase,
    localStreamURL,
    remoteStreamURL,
    isMuted,
    isRemoteMuted,
    isSpeakerOn,
    isCameraOff,
    isRemoteCameraOff,
    isScreenSharing,
    isRemoteScreenSharing,
    isFrontCamera,
    callDurationSec,
    isSystemInterrupted,
    endCall,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
    switchCamera,
    toggleScreenShare,
  } = useCall();
  const screenCapturePickerRef = useRef<unknown>(null);

  const onToggleScreenShare = async () => {
    if (Platform.OS === "ios" && !isScreenSharing) {
      const nodeHandle = findNodeHandle(screenCapturePickerRef.current as any);
      if (nodeHandle != null) ScreenCapturePickerViewManager?.show(nodeHandle);
    }
    await toggleScreenShare();
  };
  // Static per app run in practice (depends on OS version/feature support,
  // not anything that changes mid-call) — checked once rather than on every
  // render. False on iOS/web today; see modules/expo-call-pip.
  const [pipSupported] = useState(() => {
    try {
      return ExpoCallPip.isSupported();
    } catch {
      return false;
    }
  });

  // Remote and local video visibility are tracked independently: whether
  // *my* camera is on shouldn't hide the peer's video on my own screen, and
  // vice versa (isRemoteCameraOff comes from the peer's call:camera-state).
  const remoteVideoActive = call?.kind === "video" && !isRemoteCameraOff && !!remoteStreamURL;
  // Screen sharing suppresses our own preview entirely rather than showing
  // the capture in the small self-view — a live self-view of your own
  // screen capture is at best a pointless recursive thumbnail and at worst
  // (depending on capture region) an actual infinite hall-of-mirrors.
  const localVideoActive = call?.kind === "video" && !isCameraOff && !!localStreamURL && !isScreenSharing;
  // Screen content shouldn't be center-cropped the way a face/camera feed
  // is — "contain" keeps the whole shared screen visible letterboxed
  // instead of chopping off its edges.
  const remoteObjectFit = isRemoteScreenSharing ? "contain" : "cover";
  // Only meaningful to swap which side is "big" when both feeds are actually
  // on screen — with only one active there's nothing to swap it with.
  const bothVideoActive = remoteVideoActive && localVideoActive;

  // Which feed is currently shown big vs. as the small tappable preview —
  // starts (and resets) at "peer big, me small" every time both feeds become
  // available, so a swap from earlier in the call doesn't linger once the
  // other side's camera toggles off and back on.
  const [swapped, setSwapped] = useState(false);
  useEffect(() => {
    if (!bothVideoActive) setSwapped(false);
  }, [bothVideoActive]);

  if (!call) return null;

  // The big/primary slot always represents the peer — their video when
  // available, their avatar otherwise — never a fallback to showing our own
  // camera just because theirs happens to be off. Swapping to see our own
  // video big only makes sense (and is only offered, see the PIP below)
  // when both feeds are actually active.
  const showRemotePrimary = bothVideoActive ? !swapped : remoteVideoActive;
  const showLocalPrimary = bothVideoActive && swapped;

  const minimizeToPip = () => {
    const entered = ExpoCallPip.enterPipMode(PIP_ASPECT_RATIO.width, PIP_ASPECT_RATIO.height);
    if (!entered) {
      Alert.alert("Couldn't minimize", "Picture-in-picture isn't available right now.");
    }
  };

  // Pops back to whatever screen was underneath (Chat, a conversation list,
  // etc.) — the call itself lives in CallContext, independent of this
  // screen's mount state, so it keeps running behind that screen and the
  // floating widget (see FloatingCallWidget) takes over as the way back in.
  // Falls back to the main tabs on the rare cold-start path where this
  // screen has no history behind it (e.g. a CallKeep-answered call launched
  // the app directly into it) — without this, goBack() would silently no-op
  // and the button would look broken.
  const minimize = () => {
    if (!navigationRef.isReady()) return;
    if (navigationRef.canGoBack()) {
      navigationRef.goBack();
    } else {
      navigationRef.navigate("MainTabs");
    }
  };

  return (
    <View style={styles.container}>
      {showRemotePrimary ? (
        <RTCView streamURL={remoteStreamURL!} style={StyleSheet.absoluteFill} objectFit={remoteObjectFit} zOrder={0} />
      ) : showLocalPrimary ? (
        <RTCView
          streamURL={localStreamURL!}
          style={StyleSheet.absoluteFill}
          objectFit="cover"
          mirror={isFrontCamera}
          zOrder={0}
        />
      ) : (
        <View style={styles.avatarBackdrop}>
          <Avatar name={call.peerName} avatarUrl={call.peerAvatarUrl} size={160} />
        </View>
      )}

      {/* The small preview always shows our own camera whenever it's on,
          regardless of the peer's state — swapping to preview the peer's
          feed small (while our own goes big) is only offered when both
          feeds are actually active; there's nothing useful to swap to
          otherwise. */}
      {localVideoActive ? (
        <Pressable
          style={[styles.localPreview, { top: insets.top + 16 }]}
          onPress={bothVideoActive ? () => setSwapped((prev) => !prev) : undefined}
        >
          {/* zOrder=1 puts this PIP's SurfaceView above the fullscreen RTCView's —
              on Android, RTCView renders via a real SurfaceView composited outside
              normal view draw order, so two overlapping RTCViews left at the same
              (default 0) zOrder z-fight/flicker against each other. */}
          {bothVideoActive && swapped ? (
            <RTCView streamURL={remoteStreamURL!} style={StyleSheet.absoluteFill} objectFit={remoteObjectFit} zOrder={1} />
          ) : (
            <RTCView
              streamURL={localStreamURL!}
              style={StyleSheet.absoluteFill}
              objectFit="cover"
              mirror={isFrontCamera}
              zOrder={1}
            />
          )}
        </Pressable>
      ) : null}

      <View style={[styles.topOverlay, { paddingTop: insets.top + 16 }]}>
        {phase === "connected" ? (
          <Pressable style={[styles.minimizeButton, { top: insets.top + 16 }]} onPress={minimize} hitSlop={8}>
            <Ionicons name="chevron-down" size={20} color={palette.text} />
          </Pressable>
        ) : null}
        {pipSupported ? (
          <Pressable style={[styles.pipButton, { top: insets.top + 16 }]} onPress={minimizeToPip} hitSlop={8}>
            <Ionicons name="contract-outline" size={20} color={palette.text} />
          </Pressable>
        ) : null}
        <Text style={styles.name}>{call.peerName}</Text>
        <Text style={styles.status}>{statusText(phase, callDurationSec)}</Text>
        {isRemoteMuted && phase === "connected" ? (
          <View style={styles.mutedBanner}>
            <Ionicons name="mic-off" size={12} color={palette.text} />
            <Text style={styles.mutedText}>{call.peerName} is muted</Text>
          </View>
        ) : null}
        {isScreenSharing ? (
          <View style={styles.mutedBanner}>
            <Ionicons name="desktop-outline" size={12} color={palette.text} />
            <Text style={styles.mutedText}>You're sharing your screen</Text>
          </View>
        ) : null}
        {isRemoteScreenSharing ? (
          <View style={styles.mutedBanner}>
            <Ionicons name="desktop-outline" size={12} color={palette.text} />
            <Text style={styles.mutedText}>{call.peerName} is sharing their screen</Text>
          </View>
        ) : null}
        {isSystemInterrupted ? (
          <View style={styles.interruptedBanner}>
            <Ionicons name="alert-circle" size={14} color={palette.text} />
            <Text style={styles.interruptedText}>Paused — device is on another call</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.controlsRow}>
          <ControlButton icon={isMuted ? "mic-off" : "mic"} active={isMuted} onPress={toggleMute} />
          <ControlButton
            icon={isSpeakerOn ? "volume-high" : "volume-medium"}
            active={isSpeakerOn}
            onPress={toggleSpeaker}
          />
          <ControlButton
            icon={isCameraOff ? "videocam-off" : "videocam"}
            active={isCameraOff}
            onPress={toggleCamera}
          />
          <ControlButton icon="camera-reverse" onPress={switchCamera} disabled={isCameraOff} />
          <ControlButton
            icon="desktop-outline"
            active={isScreenSharing}
            onPress={() => void onToggleScreenShare()}
          />
        </View>
        {/* Hidden native view — never actually seen, just gives
            ScreenCapturePickerViewManager.show() a node handle to target on
            iOS (see onToggleScreenShare above). No-ops as a plain empty view
            on Android. */}
        {Platform.OS === "ios" ? (
          <TypedScreenCapturePickerView ref={screenCapturePickerRef} style={styles.hiddenScreenPicker} />
        ) : null}
        <Pressable style={styles.endButton} onPress={endCall}>
          <Ionicons name="call" size={28} color="#fff" style={styles.endIcon} />
        </Pressable>
      </View>
    </View>
  );
}

function ControlButton({
  icon,
  active,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.controlButton, { backgroundColor: active ? palette.controlActive : palette.controlIdle }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name={icon} size={24} color={active ? "#111" : "#fff"} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.background },
  avatarBackdrop: { flex: 1, alignItems: "center", justifyContent: "center" },
  localPreview: {
    position: "absolute",
    right: 16,
    width: 96,
    height: 170,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  topOverlay: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  minimizeButton: {
    position: "absolute",
    left: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  pipButton: {
    position: "absolute",
    right: 20,
    width: 36,
    height: 80,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  name: { color: palette.text, fontSize: 22, fontWeight: "700" },
  status: { color: palette.textSecondary, fontSize: 15, marginTop: 4 },
  interruptedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "rgba(255,59,48,0.85)",
  },
  interruptedText: { color: palette.text, fontSize: 12, fontWeight: "600" },
  mutedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  mutedText: { color: palette.text, fontSize: 12, fontWeight: "600" },
  controls: { position: "absolute", bottom: 0, left: 0, right: 0, alignItems: "center", gap: 28 },
  hiddenScreenPicker: { width: 0, height: 0 },
  controlsRow: { flexDirection: "row", gap: 20 },
  controlButton: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  endButton: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: palette.end,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  endIcon: { transform: [{ rotate: "135deg" }] },
});
