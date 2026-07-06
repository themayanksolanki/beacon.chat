import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList, MainTabParamList } from "../../App";
import { useCall } from "../calls/CallContext";
import { getCallHistory, type CallHistoryEntry } from "../db/database";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "CallHistory">,
  NativeStackScreenProps<MainStackParamList>
>;

function formatCallTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatCallDuration(entry: CallHistoryEntry): string | null {
  if (entry.status !== "completed" || !entry.answered_at || !entry.ended_at) return null;
  const totalSeconds = Math.max(0, Math.round((entry.ended_at - entry.answered_at) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function CallDirectionIcon({ entry, colors }: { entry: CallHistoryEntry; colors: ThemeColors }) {
  if (entry.status === "missed" || entry.status === "declined" || entry.status === "failed") {
    return <Ionicons name="arrow-down-outline" size={13} color={colors.danger} style={styles.directionIcon} />;
  }
  if (entry.direction === "outgoing") {
    return <Ionicons name="arrow-up-outline" size={13} color={colors.textTertiary} style={styles.directionIcon} />;
  }
  return <Ionicons name="arrow-down-outline" size={13} color={colors.textTertiary} style={styles.directionIcon} />;
}

function statusLabel(entry: CallHistoryEntry): string {
  if (entry.status === "missed") return entry.direction === "incoming" ? "Missed" : "No answer";
  if (entry.status === "declined") return "Declined";
  if (entry.status === "failed") return "Call failed";
  const duration = formatCallDuration(entry);
  return duration ?? "Completed";
}

export default function CallHistoryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const themedStyles = useMemo(() => createStyles(colors), [colors]);
  const { startCall } = useCall();
  const [history, setHistory] = useState<CallHistoryEntry[]>([]);

  useFocusEffect(
    useCallback(() => {
      setHistory(getCallHistory());
    }, [])
  );

  return (
    <View style={themedStyles.container}>
      {history.length === 0 ? (
        <View style={themedStyles.center}>
          <Ionicons name="call-outline" size={36} color={colors.textTertiary} />
          <Text style={themedStyles.empty}>No call history yet</Text>
        </View>
      ) : (
        <FlatList
          data={history}
          keyExtractor={(item) => item.id}
          contentContainerStyle={themedStyles.list}
          renderItem={({ item }) => {
            const name = item.display_name ?? "Unknown";
            const isMissedLike = item.status === "missed" || item.status === "declined" || item.status === "failed";
            return (
              <Pressable
                style={themedStyles.row}
                onPress={() => navigation.navigate("Chat", { conversationId: item.conversation_id })}
              >
                <View style={[themedStyles.avatar, { backgroundColor: colorForName(name) }]}>
                  <Text style={themedStyles.avatarText}>{initialFor(name)}</Text>
                </View>
                <View style={themedStyles.info}>
                  <Text style={[themedStyles.name, isMissedLike && themedStyles.nameMissed]} numberOfLines={1}>
                    {name}
                  </Text>
                  <View style={themedStyles.statusRow}>
                    <CallDirectionIcon entry={item} colors={colors} />
                    <Text style={themedStyles.status} numberOfLines={1}>
                      {statusLabel(item)}
                    </Text>
                  </View>
                </View>
                <Text style={themedStyles.time}>{formatCallTimestamp(item.started_at)}</Text>
                <Pressable
                  style={themedStyles.redialButton}
                  onPress={() => startCall(item.conversation_id, item.kind)}
                  hitSlop={8}
                >
                  <Ionicons
                    name={item.kind === "video" ? "videocam-outline" : "call-outline"}
                    size={20}
                    color={colors.accent}
                  />
                </Pressable>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  directionIcon: { marginRight: 2 },
});

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
    empty: { color: colors.textTertiary },
    list: { padding: 12, gap: 2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 12,
    },
    avatar: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
    avatarText: { fontSize: 17, fontWeight: "700", color: "#fff" },
    info: { flex: 1 },
    name: { fontSize: 16, fontWeight: "600", color: colors.text },
    nameMissed: { color: colors.danger },
    statusRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
    status: { fontSize: 13, color: colors.textSecondary },
    time: { fontSize: 12, color: colors.textTertiary, marginRight: 8 },
    redialButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentSoft,
    },
  });
