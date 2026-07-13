import { useEffect, useRef, useState } from "react";
import { Animated, Dimensions, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { RTCView } from "react-native-webrtc";

import { useCall } from "../calls/CallContext";
import { statusText } from "../calls/callFormat";
import { navigationRef } from "../navigation/navigationRef";
import Avatar from "./Avatar";

const CARD_WIDTH = 150;
const CORNER_PADDING = 8;
const PREVIEW_HEIGHT = 134;
const CONTROLS_HEIGHT = 44;
const CARD_HEIGHT = PREVIEW_HEIGHT + CONTROLS_HEIGHT;
const EDGE_MARGIN = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// Rendered as a sibling of the main navigator (see App.tsx), not inside any
// Navigator's own subtree, so useNavigationState (which needs a navigator
// ancestor) isn't available here — subscribe to the ref's own "state" event
// instead, which navigationRef supports even before the container is ready
// (it just buffers the listener, see createNavigationContainerRef). Every
// other method on that ref logs NOT_INITIALIZED_ERROR if called before
// ready, so getCurrentRoute() is always guarded by isReady() first.
function useCurrentRouteName(): string | undefined {
  const [routeName, setRouteName] = useState<string | undefined>(() =>
    navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined
  );

  useEffect(() => {
    const update = () => setRouteName(navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined);
    update();
    return navigationRef.addListener("state", update);
  }, []);

  return routeName;
}

function MiniButton({
  icon,
  active,
  danger,
  disabled,
  rotate,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  rotate?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[
        styles.miniButton,
        danger ? styles.miniButtonDanger : { backgroundColor: active ? "#fff" : "rgba(255,255,255,0.18)" },
        disabled && styles.miniButtonDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
    >
      <Ionicons
        name={icon}
        size={14}
        color={danger ? "#fff" : active ? "#111" : "#fff"}
        style={rotate ? { transform: [{ rotate }] } : undefined}
      />
    </Pressable>
  );
}

/**
 * The call itself keeps running in CallContext regardless of which screen,
 * if any, is showing ActiveCallScreen — this is the "minimized" surface for
 * that: a small draggable card (a live video thumbnail for video calls, the
 * peer's avatar for audio) with the same quick controls as the full call
 * screen, so the user can keep chatting/navigating with the call still
 * visibly running, then tap the preview to bring the full screen back.
 */
export default function FloatingCallWidget() {
  const insets = useSafeAreaInsets();
  const {
    call,
    phase,
    remoteStreamURL,
    isMuted,
    isSpeakerOn,
    isCameraOff,
    isRemoteCameraOff,
    callDurationSec,
    endCall,
    toggleMute,
    toggleSpeaker,
    toggleCamera,
  } = useCall();
  const routeName = useCurrentRouteName();

  const [{ width: screenW, height: screenH }] = useState(() => Dimensions.get("window"));
  const bounds = {
    minX: EDGE_MARGIN,
    maxX: screenW - CARD_WIDTH - EDGE_MARGIN,
    minY: insets.top + EDGE_MARGIN,
    maxY: screenH - insets.bottom - CARD_HEIGHT - EDGE_MARGIN,
  };

  const posRef = useRef({ x: bounds.maxX, y: bounds.minY + 56 });
  const pan = useRef(new Animated.ValueXY(posRef.current)).current;

  // Attached to the whole card (preview + controls), not just a dedicated
  // drag handle — safe because PanResponder only claims the gesture once the
  // touch has actually moved past the threshold below (onMoveShouldSet, not
  // onStartShouldSet); a plain tap on a button never moves that far, so it
  // resolves as a normal Pressable press instead of a drag. Same pattern as
  // ChatScreen's MessageBubble swipe-to-reply over its own long-pressable body.
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8,
      onPanResponderMove: (_evt, gesture) => {
        const x = clamp(posRef.current.x + gesture.dx, bounds.minX, bounds.maxX);
        const y = clamp(posRef.current.y + gesture.dy, bounds.minY, bounds.maxY);
        pan.setValue({ x, y });
      },
      onPanResponderRelease: (_evt, gesture) => {
        const rawX = posRef.current.x + gesture.dx;
        const y = clamp(posRef.current.y + gesture.dy, bounds.minY, bounds.maxY);
        // Snap to whichever side edge is closer, Messenger-chat-head style,
        // so the card always ends up somewhere it can't be forgotten
        // half-covering the middle of the screen.
        const x = rawX + CARD_WIDTH / 2 < screenW / 2 ? bounds.minX : bounds.maxX;
        posRef.current = { x, y };
        Animated.spring(pan, { toValue: posRef.current, useNativeDriver: false, friction: 7 }).start();
      },
    })
  ).current;

  if (!call || phase === "idle") return null;
  if (routeName === "ActiveCall" || routeName === "IncomingCall") return null;

  const isVideoCall = call.kind === "video";
  // This widget always represents the peer, never a fallback to our own
  // camera — same principle as ActiveCallScreen's primary view: showing our
  // own video here just because the peer's camera is off isn't useful for a
  // "glance at the call" widget, and reads as if we were staring at
  // ourselves.
  const showRemoteVideo = isVideoCall && !isRemoteCameraOff && !!remoteStreamURL;
  const expand = () => navigationRef.isReady() && navigationRef.navigate("ActiveCall");

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[styles.wrap, { transform: [{ translateX: pan.x }, { translateY: pan.y }] }]}
    >
      <Pressable style={styles.preview} onPress={expand}>
        {showRemoteVideo ? (
          <RTCView streamURL={remoteStreamURL!} style={StyleSheet.absoluteFill} objectFit="cover" zOrder={0} />
        ) : (
          <View style={styles.avatarBackdrop}>
            <Avatar name={call.peerName} avatarUrl={call.peerAvatarUrl} size={48} />
          </View>
        )}
        <View style={styles.previewFooter} pointerEvents="none">
          <Text style={styles.previewName} numberOfLines={1}>
            {call.peerName}
          </Text>
          <Text style={styles.previewStatus} numberOfLines={1}>
            {statusText(phase, callDurationSec)}
          </Text>
        </View>
      </Pressable>

      <View style={styles.micCorner}>
        <MiniButton icon={isMuted ? "mic-off" : "mic"} active={isMuted} onPress={toggleMute} />
      </View>

      <View style={styles.controlsRow}>
        <MiniButton icon={isSpeakerOn ? "volume-high" : "volume-medium"} active={isSpeakerOn} onPress={toggleSpeaker} />
        {isVideoCall ? (
          <MiniButton icon={isCameraOff ? "videocam-off" : "videocam"} active={isCameraOff} onPress={toggleCamera} />
        ) : null}
        <MiniButton icon="call" danger onPress={endCall} rotate="135deg" />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    top: 0,
    width: CARD_WIDTH,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#0B0B10",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 100,
  },
  preview: { width: "100%", height: PREVIEW_HEIGHT },
  avatarBackdrop: { flex: 1, alignItems: "center", justifyContent: "center" },
  previewFooter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  previewName: { color: "#fff", fontSize: 12, fontWeight: "700" },
  previewStatus: { color: "rgba(255,255,255,0.75)", fontSize: 11 },
  micCorner: { position: "absolute", top: CORNER_PADDING, right: CORNER_PADDING },
  controlsRow: {
    height: CONTROLS_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  miniButton: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  miniButtonDanger: { backgroundColor: "#FF3B30" },
  miniButtonDisabled: { opacity: 0.4 },
});
