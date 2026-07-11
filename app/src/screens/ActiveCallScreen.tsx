import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { RTCView } from "react-native-webrtc";

import ExpoCallPip from "../../modules/expo-call-pip";
import { useCall } from "../calls/CallContext";
import { statusText } from "../calls/callFormat";
import { navigationRef } from "../navigation/navigationRef";
import Avatar from "../components/Avatar";

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
    isSpeakerOn,
    isCameraOff,
    isRemoteCameraOff,
    callDurationSec,
    isSystemInterrupted,
    endCall,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
    switchCamera,
  } = useCall();
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

  if (!call) return null;

  // Remote and local video visibility are tracked independently: whether
  // *my* camera is on shouldn't hide the peer's video on my own screen, and
  // vice versa (isRemoteCameraOff comes from the peer's call:camera-state).
  const remoteVideoActive = call.kind === "video" && !isRemoteCameraOff && !!remoteStreamURL;
  const localVideoActive = call.kind === "video" && !isCameraOff && !!localStreamURL;
  const showRemotePrimary = remoteVideoActive;
  const showLocalPrimary = !showRemotePrimary && localVideoActive;
  const showLocalPip = showRemotePrimary && localVideoActive;

  const minimizeToPip = () => {
    const entered = ExpoCallPip.enterPipMode(PIP_ASPECT_RATIO.width, PIP_ASPECT_RATIO.height);
    if (!entered) {
      Alert.alert("Couldn't minimize", "Picture-in-picture isn't available right now.");
    }
  };

  const minimizeToChat = () => {
    if (navigationRef.isReady()) navigationRef.goBack();
  };

  return (
    <View style={styles.container}>
      {showRemotePrimary ? (
        <RTCView streamURL={remoteStreamURL!} style={StyleSheet.absoluteFill} objectFit="cover" />
      ) : showLocalPrimary ? (
        <RTCView streamURL={localStreamURL!} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
      ) : (
        <View style={styles.avatarBackdrop}>
          <Avatar name={call.peerName} avatarUrl={call.peerAvatarUrl} size={160} />
        </View>
      )}

      {showLocalPip ? (
        <View style={[styles.localPreview, { top: insets.top + 16 }]}>
          <RTCView streamURL={localStreamURL!} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
        </View>
      ) : null}

      <View style={[styles.topOverlay, { paddingTop: insets.top + 16 }]}>
        {phase === "connected" ? (
          <Pressable style={styles.minimizeButton} onPress={minimizeToChat} hitSlop={8}>
            <Ionicons name="chevron-down" size={20} color={palette.text} />
          </Pressable>
        ) : null}
        {pipSupported ? (
          <Pressable style={styles.pipButton} onPress={minimizeToPip} hitSlop={8}>
            <Ionicons name="contract-outline" size={20} color={palette.text} />
          </Pressable>
        ) : null}
        <Text style={styles.name}>{call.peerName}</Text>
        <Text style={styles.status}>{statusText(phase, callDurationSec)}</Text>
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
        </View>
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
    height: 140,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  topOverlay: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  minimizeButton: {
    position: "absolute",
    top: 20,
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
    top: 0,
    right: 20,
    width: 36,
    height: 36,
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
  controls: { position: "absolute", bottom: 0, left: 0, right: 0, alignItems: "center", gap: 28 },
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
