import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { unarchiveChat } from "../chat/archivedChats";
import { acceptContactRequest, rejectContactRequest } from "../chat/contactRequests";
import { deleteConversation } from "../chat/deleteConversation";
import ConversationRow from "../components/ConversationRow";
import MessageActionMenu, { type MessageAction, type MessageMenuAnchor } from "../components/MessageActionMenu";
import { blockUser, getArchivedConversationSummaries, type ConversationSummary } from "../db/database";
import { useMessaging } from "../messaging/MessagingContext";
import { usePresence } from "../presence/PresenceContext";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "ArchivedChats">;

export default function ArchivedChatsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ anchor: MessageMenuAnchor; actions: MessageAction[] } | null>(null);
  const { presence, subscribe } = usePresence();
  const { revision } = useMessaging();

  const refresh = useCallback(() => {
    setConversations(getArchivedConversationSummaries());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  useEffect(() => {
    refresh();
  }, [revision, refresh]);

  useEffect(() => {
    if (conversations.length > 0) subscribe(conversations.map((c) => c.id));
  }, [conversations, subscribe]);

  // Client-side name/number filter — there's no message-content search
  // anywhere in the app yet to extend, so this just keeps the requirement
  // that archived chats stay findable rather than becoming a dead-end list.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.display_name?.toLowerCase().includes(q) || c.contact_number?.toLowerCase().includes(q)
    );
  }, [conversations, query]);

  const handleAccept = useCallback(
    async (peerId: string) => {
      const ok = await acceptContactRequest(peerId);
      if (!ok) Alert.alert("Couldn't accept", "Please try again.");
      refresh();
    },
    [refresh]
  );

  const handleReject = useCallback(
    (peerId: string, name: string) => {
      Alert.alert("Decline this request?", `Choose what to do about ${name}.`, [
        {
          text: "Report",
          style: "destructive",
          onPress: async () => {
            await rejectContactRequest(peerId, "report");
            refresh();
          },
        },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            await rejectContactRequest(peerId, "block");
            refresh();
          },
        },
        {
          text: "No action",
          onPress: async () => {
            await rejectContactRequest(peerId, "none");
            refresh();
          },
        },
      ]);
    },
    [refresh]
  );

  const handleUnarchive = useCallback(
    async (conversationId: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      const ok = await unarchiveChat(conversationId);
      if (!ok) Alert.alert("Couldn't restore chat", "Please try again.");
      refresh();
    },
    [refresh]
  );

  const showChatOptions = useCallback(
    (conversationId: string, anchor: MessageMenuAnchor) => {
      setMenu({
        anchor,
        actions: [
          {
            label: "Unarchive Chat",
            icon: "archive-outline",
            onPress: () => handleUnarchive(conversationId),
          },
          {
            label: "Delete Chat",
            icon: "trash-outline",
            destructive: true,
            onPress: () => {
              deleteConversation(conversationId);
              refresh();
            },
          },
          {
            label: "Block User",
            icon: "ban-outline",
            destructive: true,
            onPress: () => {
              blockUser(conversationId);
              refresh();
            },
          },
          {
            label: "Delete User",
            icon: "person-remove-outline",
            destructive: true,
            onPress: () => {
              blockUser(conversationId);
              deleteConversation(conversationId);
              refresh();
            },
          },
        ],
      });
    },
    [handleUnarchive, refresh]
  );

  return (
    // No wrapping Pressable for "tap outside to dismiss" — it competed with
    // the FlatList below for scroll gestures and broke dragging on blank
    // list space. keyboardShouldPersistTaps defaults to "never", which
    // already dismisses the keyboard on tapping anywhere in the list that
    // isn't a nested touchable, with no extra wrapper needed.
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search archived chats"
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {conversations.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="archive-outline" size={32} color={colors.textTertiary} />
          <Text style={styles.empty}>No archived chats</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No matches for "{query}"</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              isOnline={item.is_blocked ? false : presence[item.id]?.online ?? false}
              colors={colors}
              onPress={() => navigation.navigate("Chat", { conversationId: item.id })}
              onLongPressAt={(anchor) => showChatOptions(item.id, anchor)}
              onAccept={() => handleAccept(item.id)}
              onReject={() => handleReject(item.id, item.display_name ?? "this person")}
            />
          )}
        />
      )}

      <MessageActionMenu
        visible={!!menu}
        anchor={menu?.anchor ?? null}
        actions={menu?.actions ?? []}
        onClose={() => setMenu(null)}
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
    empty: { color: colors.textTertiary, textAlign: "center" },
    list: { paddingTop: 4, paddingBottom: 12 },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
  });
