import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { RTCView } from "react-native-webrtc";

import { useCall } from "../calls/CallContext";
import { colorForName, initialFor } from "../theme";

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

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function statusText(phase: string, durationSec: number): string {
  if (phase === "outgoing-ringing") return "Calling…";
  if (phase === "connecting") return "Connecting…";
  if (phase === "connected") return formatDuration(durationSec);
  return "";
}

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
    callDurationSec,
    endCall,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
    switchCamera,
  } = useCall();

  if (!call) return null;

  const showVideo = call.kind === "video" && !isCameraOff;
  const primaryStreamURL = remoteStreamURL ?? localStreamURL;
  const showLocalPip = showVideo && !!remoteStreamURL && !!localStreamURL;

  return (
    <View style={styles.container}>
      {showVideo && primaryStreamURL ? (
        <RTCView streamURL={primaryStreamURL} style={StyleSheet.absoluteFill} objectFit="cover" />
      ) : (
        <View style={styles.avatarBackdrop}>
          <View style={[styles.avatar, { backgroundColor: colorForName(call.peerName) }]}>
            <Text style={styles.avatarInitial}>{initialFor(call.peerName)}</Text>
          </View>
        </View>
      )}

      {showLocalPip ? (
        <View style={[styles.pip, { top: insets.top + 16 }]}>
          <RTCView streamURL={localStreamURL!} style={StyleSheet.absoluteFill} objectFit="cover" mirror />
        </View>
      ) : null}

      <View style={[styles.topOverlay, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.name}>{call.peerName}</Text>
        <Text style={styles.status}>{statusText(phase, callDurationSec)}</Text>
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.controlsRow}>
          <ControlButton icon={isMuted ? "mic-off" : "mic"} active={isMuted} onPress={toggleMute} />
          <ControlButton
            icon={isSpeakerOn ? "volume-high" : "volume-medium"}
            active={isSpeakerOn}
            onPress={toggleSpeaker}
          />
          {call.kind === "video" ? (
            <>
              <ControlButton
                icon={isCameraOff ? "videocam-off" : "videocam"}
                active={isCameraOff}
                onPress={toggleCamera}
              />
              <ControlButton icon="camera-reverse" onPress={switchCamera} disabled={isCameraOff} />
            </>
          ) : null}
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
  avatar: { width: 160, height: 160, borderRadius: 80, alignItems: "center", justifyContent: "center" },
  avatarInitial: { fontSize: 60, fontWeight: "700", color: "#fff" },
  pip: {
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
  name: { color: palette.text, fontSize: 22, fontWeight: "700" },
  status: { color: palette.textSecondary, fontSize: 15, marginTop: 4 },
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
