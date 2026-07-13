import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList, MainTabParamList } from "../../App";
import { archiveChat, unarchiveChat } from "../chat/archivedChats";
import { acceptContactRequest, rejectContactRequest } from "../chat/contactRequests";
import { deleteConversation } from "../chat/deleteConversation";
import ConversationRow from "../components/ConversationRow";
import MessageActionMenu, { type MessageAction, type MessageMenuAnchor } from "../components/MessageActionMenu";
import UndoSnackbar from "../components/UndoSnackbar";
import {
  blockUser,
  getArchivedConversationCount,
  getConversationSummaries,
  type ConversationSummary,
} from "../db/database";
import { useMessaging } from "../messaging/MessagingContext";
import { usePresence } from "../presence/PresenceContext";
import { ensureTestBotConversation, syncTestBotConversationIfPresent, TEST_BOT_CONVERSATION_ID, TEST_BOT_NAME } from "../testBot";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Chats">,
  NativeStackScreenProps<MainStackParamList>
>;

export default function ConversationListScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [archivedCount, setArchivedCount] = useState(0);
  const [menu, setMenu] = useState<{ anchor: MessageMenuAnchor; actions: MessageAction[] } | null>(null);
  const [undo, setUndo] = useState<{ conversationId: string; name: string } | null>(null);
  const { presence, subscribe } = usePresence();
  const { revision } = useMessaging();

  const refresh = useCallback(() => {
    setConversations(getConversationSummaries());
    setArchivedCount(getArchivedConversationCount());
  }, []);

  useFocusEffect(
    useCallback(() => {
      syncTestBotConversationIfPresent();
      refresh();
    }, [refresh])
  );

  // Keep the list (previews, unread badges) live while it's mounted, not just
  // on focus — a message can arrive while the user is sitting on this screen.
  useEffect(() => {
    refresh();
  }, [revision, refresh]);

  useEffect(() => {
    if (conversations.length > 0) subscribe(conversations.map((c) => c.id));
  }, [conversations, subscribe]);

  const openTestBot = () => {
    ensureTestBotConversation();
    navigation.navigate("Chat", { conversationId: TEST_BOT_CONVERSATION_ID });
  };

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

  // Archiving is instant with an Undo affordance rather than a blocking
  // confirm dialog — it's fully reversible (see requirement: "confirmation
  // OR undo option"), and a chat that just got new activity while archived
  // still updates normally, it simply stays out of this list (see
  // getConversationSummaries' is_archived filter).
  const handleArchive = useCallback(
    async (conversationId: string, name: string) => {
      // Optimistic: drop it from the visible list immediately, before the
      // server round-trip resolves — archiveChat only writes it to local
      // SQLite once the ack confirms, so a plain refresh() here would still
      // show it until then.
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      setUndo({ conversationId, name });
      const ok = await archiveChat(conversationId);
      if (!ok) {
        Alert.alert("Couldn't archive", "Please try again.");
        setUndo(null);
      }
      refresh();
    },
    [refresh]
  );

  const showChatOptions = useCallback(
    (conversationId: string, name: string, anchor: MessageMenuAnchor) => {
      setMenu({
        anchor,
        actions: [
          {
            label: "Archive Chat",
            icon: "archive-outline",
            onPress: () => handleArchive(conversationId, name),
          },
          {
            label: "Delete Chat",
            icon: "trash-outline",
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
            onPress: () => {
              blockUser(conversationId);
              deleteConversation(conversationId);
              refresh();
            },
          },
        ],
      });
    },
    [handleArchive, refresh]
  );

  return (
    <View style={styles.container}>
      <Pressable style={styles.testBotCard} onPress={openTestBot}>
        <View style={styles.testBotAvatar}>
          <Text style={styles.testBotEmoji}>🤖</Text>
        </View>
        <Text style={styles.testBotText}>Chat with {TEST_BOT_NAME}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.accent} />
      </Pressable>

      {archivedCount > 0 ? (
        <Pressable style={styles.archivedRow} onPress={() => navigation.navigate("ArchivedChats")}>
          <View style={styles.archivedIconWrap}>
            <Ionicons name="archive-outline" size={18} color={colors.textSecondary} />
          </View>
          <Text style={styles.archivedText}>Archived</Text>
          <Text style={styles.archivedCount}>{archivedCount}</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </Pressable>
      ) : null}

      {conversations.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No chats yet. Tap + to start one.</Text>
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              isOnline={item.is_blocked ? false : presence[item.id]?.online ?? false}
              colors={colors}
              onPress={() => navigation.navigate("Chat", { conversationId: item.id })}
              onLongPressAt={(anchor) => showChatOptions(item.id, item.display_name ?? "this person", anchor)}
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

      <UndoSnackbar
        visible={!!undo}
        message={undo ? `${undo.name} archived` : ""}
        onUndo={() => {
          // Safe even if the archive ack hasn't landed yet — unarchiveChat
          // just becomes a same-tick follow-up conversation:unarchive, and
          // the server/local state end up correct either way.
          if (undo) void unarchiveChat(undo.conversationId).then(refresh);
        }}
        onDismiss={() => setUndo(null)}
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    empty: { color: colors.textTertiary, textAlign: "center" },
    list: { paddingTop: 4, paddingBottom: 12 },
    testBotCard: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: 12,
      marginTop: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 12,
      borderRadius: 18,
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
    archivedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 12,
      marginTop: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    archivedIconWrap: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: colors.background,
      alignItems: "center",
      justifyContent: "center",
    },
    archivedText: { flex: 1, fontSize: 14.5, fontWeight: "600", color: colors.text },
    archivedCount: { fontSize: 13, color: colors.textTertiary },
  });
