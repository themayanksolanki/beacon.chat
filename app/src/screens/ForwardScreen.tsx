import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { MainStackParamList } from "../../App";
import Avatar from "../components/Avatar";
import { getConversationSummaries, getMessageById, type ConversationSummary } from "../db/database";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "Forward">;

/** One-line summary of what's being forwarded, shown above the chat list — mirrors the labels ChatScreen uses for non-text kinds in its own preview text. */
function forwardPreviewLabel(messageIds: string[]): string {
  if (messageIds.length > 1) return `${messageIds.length} messages`;
  const message = getMessageById(messageIds[0]);
  if (!message) return "Message";
  if (message.kind === "voice") return "🎤 Voice message";
  if (message.kind === "image") return "📷 Photo";
  if (message.kind === "gif") return "🎞️ GIF";
  if (message.kind === "video") return "🎬 Video";
  if (message.kind === "file") return `📎 ${message.file_name ?? "File"}`;
  if (message.kind === "contact") return `👤 ${message.contact_name ?? "Contact"}`;
  return message.plaintext;
}

export default function ForwardScreen({ route, navigation }: Props) {
  const { messageIds, sourceConversationId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [conversations] = useState<ConversationSummary[]>(() =>
    getConversationSummaries().filter((c) => c.status === "accepted" && !c.is_blocked)
  );
  const previewLabel = useMemo(() => forwardPreviewLabel(messageIds), [messageIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => (c.display_name ?? "unknown").toLowerCase().includes(q));
  }, [conversations, query]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const confirmForward = useCallback(() => {
    if (selectedIds.size === 0) return;
    navigation.navigate("Chat", {
      conversationId: sourceConversationId,
      forwardTargets: Array.from(selectedIds),
      forwardMessageIds: messageIds,
    });
  }, [navigation, selectedIds, sourceConversationId, messageIds]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable onPress={confirmForward} disabled={selectedIds.size === 0} hitSlop={8}>
          <Ionicons name="send" size={22} color={selectedIds.size === 0 ? colors.textTertiary : colors.accent} />
        </Pressable>
      ),
    });
  }, [navigation, confirmForward, selectedIds, colors]);

  return (
    // No wrapping Pressable for "tap outside to dismiss" — it competed with
    // the FlatList below for scroll gestures and broke dragging on blank
    // list space. keyboardShouldPersistTaps defaults to "never", which
    // already dismisses the keyboard on tapping anywhere in the list that
    // isn't a nested touchable, with no extra wrapper needed.
    <View style={styles.container}>
      <View style={styles.previewBar}>
        <Ionicons name="arrow-redo-outline" size={16} color={colors.textSecondary} />
        <Text style={styles.previewText} numberOfLines={1}>
          Forwarding: {previewLabel}
        </Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats"
          placeholderTextColor={colors.textTertiary}
          style={styles.searchInput}
        />
      </View>

      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No chats found</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ForwardRow
              item={item}
              selected={selectedIds.has(item.id)}
              colors={colors}
              styles={styles}
              onPress={() => toggleSelected(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}

function ForwardRow({
  item,
  selected,
  colors,
  styles,
  onPress,
}: {
  item: ConversationSummary;
  selected: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}) {
  const name = item.display_name ?? "Unknown";
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      <Avatar name={name} avatarUrl={item.avatar_url} size={44} />
      <Text style={styles.rowName} numberOfLines={1}>
        {name}
      </Text>
      <Ionicons
        name={selected ? "checkmark-circle" : "ellipse-outline"}
        size={22}
        color={selected ? colors.accent : colors.textTertiary}
      />
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    previewBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: colors.accentSoft,
    },
    previewText: { flex: 1, fontSize: 13, color: colors.textSecondary, fontStyle: "italic" },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.surface,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
    list: { padding: 12, paddingTop: 8, gap: 8 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center" },
    emptyText: { color: colors.textTertiary, fontSize: 15 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 16,
      backgroundColor: colors.surface,
    },
    rowPressed: { opacity: 0.7 },
    rowName: { flex: 1, fontSize: 15.5, fontWeight: "600", color: colors.text },
  });
