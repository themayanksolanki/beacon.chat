import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { useCall } from "../calls/CallContext";
import { statusText } from "../calls/callFormat";
import { navigationRef } from "../navigation/navigationRef";
import { useTheme } from "../ThemeContext";
import Avatar from "./Avatar";

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

// The call itself keeps running in CallContext regardless of which screen,
// if any, is showing ActiveCallScreen — this banner just reflects that state
// while letting the user navigate the rest of the app during a call.
export default function ActiveCallBanner() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { call, phase, callDurationSec } = useCall();
  const routeName = useCurrentRouteName();

  if (!call || phase === "idle") return null;
  if (routeName === "ActiveCall" || routeName === "IncomingCall") return null;

  return (
    <Pressable
      style={[styles.bar, { top: insets.top, backgroundColor: colors.accent }]}
      onPress={() => navigationRef.isReady() && navigationRef.navigate("ActiveCall")}
    >
      <Avatar name={call.peerName} avatarUrl={call.peerAvatarUrl} size={28} />
      <Text style={styles.name} numberOfLines={1}>
        {call.peerName}
      </Text>
      <Text style={styles.status}>{statusText(phase, callDurationSec)}</Text>
      <Ionicons name="chevron-up" size={16} color="#fff" style={styles.chevron} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 100,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  name: { color: "#fff", fontSize: 14, fontWeight: "700", flexShrink: 1 },
  status: { color: "rgba(255,255,255,0.85)", fontSize: 13, marginLeft: "auto" },
  chevron: { marginLeft: 2 },
});
