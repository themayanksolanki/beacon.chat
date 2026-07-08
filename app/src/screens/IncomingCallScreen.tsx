import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { useCall } from "../calls/CallContext";
import { colorForName, initialFor } from "../theme";

// Always dark, regardless of the app's light/dark setting — matches the
// system's own incoming-call/FaceTime treatment, which never switches to a
// light appearance.
const palette = {
  background: "#0B0B10",
  text: "#FFFFFF",
  textSecondary: "rgba(255,255,255,0.65)",
  decline: "#FF3B30",
  accept: "#34C759",
};

export default function IncomingCallScreen() {
  const insets = useSafeAreaInsets();
  const { call, acceptIncomingCall, rejectIncomingCall } = useCall();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  if (!call) return null;

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  return (
    <View style={[styles.container, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }]}>
      <Text style={styles.kind}>Incoming {call.kind === "video" ? "video" : "voice"} call</Text>

      <View style={styles.avatarWrap}>
        <Animated.View
          style={[
            styles.ring,
            { backgroundColor: colorForName(call.peerName), opacity: ringOpacity, transform: [{ scale: ringScale }] },
          ]}
        />
        <View style={[styles.avatar, { backgroundColor: colorForName(call.peerName) }]}>
          <Text style={styles.avatarInitial}>{initialFor(call.peerName)}</Text>
        </View>
      </View>
      <Text style={styles.name}>{call.peerName}</Text>

      <View style={styles.actions}>
        <View style={styles.actionColumn}>
          <Pressable
            style={[styles.actionButton, { backgroundColor: palette.decline }]}
            onPress={rejectIncomingCall}
          >
            <Ionicons name="call" size={30} color="#fff" style={styles.declineIcon} />
          </Pressable>
          <Text style={styles.actionLabel}>Decline</Text>
        </View>
        <View style={styles.actionColumn}>
          <Pressable
            style={[styles.actionButton, { backgroundColor: palette.accept }]}
            onPress={acceptIncomingCall}
          >
            <Ionicons name="call" size={30} color="#fff" />
          </Pressable>
          <Text style={styles.actionLabel}>Accept</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.background,
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
  },
  kind: { color: palette.textSecondary, fontSize: 15, fontWeight: "500" },
  avatarWrap: { alignItems: "center", justifyContent: "center", width: 180, height: 180 },
  ring: { position: "absolute", width: 180, height: 180, borderRadius: 90 },
  avatar: { width: 140, height: 140, borderRadius: 70, alignItems: "center", justifyContent: "center" },
  avatarInitial: { fontSize: 52, fontWeight: "700", color: "#fff" },
  name: { color: palette.text, fontSize: 26, fontWeight: "700", marginTop: 20 },
  actions: { flexDirection: "row", justifyContent: "space-between", width: "100%", paddingHorizontal: 24 },
  actionColumn: { alignItems: "center", gap: 10 },
  actionButton: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  declineIcon: { transform: [{ rotate: "135deg" }] },
  actionLabel: { color: palette.textSecondary, fontSize: 13, fontWeight: "500" },
});
