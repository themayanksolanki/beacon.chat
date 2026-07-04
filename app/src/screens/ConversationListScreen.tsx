import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList, MainTabParamList } from "../../App";
import { getConversationSummaries, type ConversationSummary } from "../db/database";
import { ensureTestBotConversation, TEST_BOT_CONVERSATION_ID } from "../testBot";
import { colorForName, colors, initialFor } from "../theme";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Chats">,
  NativeStackScreenProps<MainStackParamList>
>;

function formatListTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  const diffDays = (now.getTime() - date.getTime()) / 86_400_000;
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ConversationListScreen({ navigation }: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  useFocusEffect(
    useCallback(() => {
      setConversations(getConversationSummaries());
    }, [])
  );

  const openTestBot = () => {
    ensureTestBotConversation();
    navigation.navigate("Chat", { conversationId: TEST_BOT_CONVERSATION_ID });
  };

  return (
    <View style={styles.container}>
      <Pressable style={styles.testBotRow} onPress={openTestBot}>
        <View style={styles.testBotAvatar}>
          <Text style={styles.testBotEmoji}>🤖</Text>
        </View>
        <Text style={styles.testBotText}>Chat with Test Bot</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.accent} />
      </Pressable>

      {conversations.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No chats yet. Tap + to start one.</Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const name = item.display_name ?? "Unknown";
            const hasUnread = item.unread_count > 0;
            return (
              <Pressable
                style={styles.row}
                onPress={() => navigation.navigate("Chat", { conversationId: item.id })}
              >
                <View style={[styles.avatar, { backgroundColor: colorForName(name) }]}>
                  <Text style={styles.avatarText}>{initialFor(name)}</Text>
                </View>
                <View style={styles.rowContent}>
                  <View style={styles.rowTop}>
                    <Text style={styles.name} numberOfLines={1}>
                      {name}
                    </Text>
                    {item.last_message_at ? (
                      <Text style={[styles.time, hasUnread && styles.timeUnread]}>
                        {formatListTimestamp(item.last_message_at)}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.rowBottom}>
                    <Text style={[styles.preview, hasUnread && styles.previewUnread]} numberOfLines={1}>
                      {item.last_message ?? "No messages yet"}
                    </Text>
                    {hasUnread ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>
                          {item.unread_count > 99 ? "99+" : item.unread_count}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  empty: { color: colors.textTertiary, textAlign: "center" },
  testBotRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.accentSoft,
  },
  testBotAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  testBotEmoji: { fontSize: 20 },
  testBotText: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.accent },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontWeight: "700", color: "#fff" },
  rowContent: { flex: 1 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { fontSize: 16, fontWeight: "600", color: colors.text, flexShrink: 1 },
  time: { fontSize: 12, color: colors.textTertiary },
  timeUnread: { color: colors.accent, fontWeight: "600" },
  rowBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 },
  preview: { fontSize: 14, color: colors.textSecondary, flex: 1, marginRight: 8 },
  previewUnread: { color: colors.text, fontWeight: "500" },
  badge: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
