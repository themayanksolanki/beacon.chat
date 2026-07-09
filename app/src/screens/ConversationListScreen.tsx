import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList, MainTabParamList } from "../../App";
import { acceptContactRequest, rejectContactRequest } from "../chat/contactRequests";
import { deleteConversation } from "../chat/deleteConversation";
import MessageActionMenu, { type MessageAction, type MessageMenuAnchor } from "../components/MessageActionMenu";
import { blockUser, getConversationSummaries, type ConversationSummary } from "../db/database";
import { useMessaging } from "../messaging/MessagingContext";
import { usePresence } from "../presence/PresenceContext";
import { ensureTestBotConversation, TEST_BOT_CONVERSATION_ID } from "../testBot";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

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

/** Read-receipt tick shown before the preview text, only for our own last outgoing message. */
function PreviewReceiptTick({ item, colors }: { item: ConversationSummary; colors: ThemeColors }) {
  if (item.last_message_direction !== "outgoing") return null;
  if (item.last_message_status === "failed") {
    return <Ionicons name="alert-circle" size={13} color={colors.danger} style={styles.receiptTick} />;
  }
  if (item.last_message_status === "read") {
    return <Ionicons name="checkmark-done" size={14} color={colors.accent} style={styles.receiptTick} />;
  }
  if (item.last_message_status === "delivered") {
    return <Ionicons name="checkmark-done" size={14} color={colors.textTertiary} style={styles.receiptTick} />;
  }
  return <Ionicons name="checkmark" size={14} color={colors.textTertiary} style={styles.receiptTick} />;
}

export default function ConversationListScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [menu, setMenu] = useState<{ anchor: MessageMenuAnchor; actions: MessageAction[] } | null>(null);
  const { presence, subscribe } = usePresence();
  const { revision } = useMessaging();

  useFocusEffect(
    useCallback(() => {
      setConversations(getConversationSummaries());
    }, [])
  );

  // Keep the list (previews, unread badges) live while it's mounted, not just
  // on focus — a message can arrive while the user is sitting on this screen.
  useEffect(() => {
    setConversations(getConversationSummaries());
  }, [revision]);

  useEffect(() => {
    if (conversations.length > 0) subscribe(conversations.map((c) => c.id));
  }, [conversations, subscribe]);

  const openTestBot = () => {
    ensureTestBotConversation();
    navigation.navigate("Chat", { conversationId: TEST_BOT_CONVERSATION_ID });
  };

  const handleAccept = useCallback(async (peerId: string) => {
    const ok = await acceptContactRequest(peerId);
    if (!ok) Alert.alert("Couldn't accept", "Please try again.");
    setConversations(getConversationSummaries());
  }, []);

  const handleReject = useCallback((peerId: string, name: string) => {
    Alert.alert("Decline this request?", `Choose what to do about ${name}.`, [
      {
        text: "Report",
        style: "destructive",
        onPress: async () => {
          await rejectContactRequest(peerId, "report");
          setConversations(getConversationSummaries());
        },
      },
      {
        text: "Block",
        style: "destructive",
        onPress: async () => {
          await rejectContactRequest(peerId, "block");
          setConversations(getConversationSummaries());
        },
      },
      {
        text: "No action",
        onPress: async () => {
          await rejectContactRequest(peerId, "none");
          setConversations(getConversationSummaries());
        },
      },
    ]);
  }, []);

  const showChatOptions = useCallback((conversationId: string, anchor: MessageMenuAnchor) => {
    setMenu({
      anchor,
      actions: [
        {
          label: "Delete Chat",
          icon: "trash-outline",
          destructive: true,
          onPress: () => {
            deleteConversation(conversationId);
            setConversations(getConversationSummaries());
          },
        },
        {
          label: "Block User",
          icon: "ban-outline",
          destructive: true,
          onPress: () => blockUser(conversationId),
        },
        {
          label: "Delete User",
          icon: "person-remove-outline",
          destructive: true,
          onPress: () => {
            blockUser(conversationId);
            deleteConversation(conversationId);
            setConversations(getConversationSummaries());
          },
        },
      ],
    });
  }, []);

  return (
    <View style={styles.container}>
      <Pressable style={styles.testBotCard} onPress={openTestBot}>
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
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ConversationRow
              item={item}
              isOnline={presence[item.id]?.online ?? false}
              colors={colors}
              styles={styles}
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

function ConversationRow({
  item,
  isOnline,
  colors,
  styles,
  onPress,
  onLongPressAt,
  onAccept,
  onReject,
}: {
  item: ConversationSummary;
  isOnline: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
  onLongPressAt: (anchor: MessageMenuAnchor) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const rowRef = useRef<View>(null);
  const name = item.display_name ?? "Unknown";
  const hasUnread = item.unread_count > 0;

  return (
    <Pressable
      ref={rowRef}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      onLongPress={() => {
        rowRef.current?.measureInWindow((x, y, width, height) => {
          onLongPressAt({ x, y, width, height });
        });
      }}
    >
      <View style={styles.avatar}>
        {item.avatar_url ? (
          <Image source={{ uri: item.avatar_url }} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.avatarFallback, { backgroundColor: colorForName(name) }]}>
            <Text style={styles.avatarText}>{initialFor(name)}</Text>
          </View>
        )}
        {isOnline ? <View style={styles.onlineDot} /> : null}
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
          {item.status === "pending_incoming" ? (
            <>
              <Text style={styles.requestLabel} numberOfLines={1}>
                Wants to message you
              </Text>
              <View style={styles.requestActions}>
                <Pressable
                  style={[styles.requestButton, styles.requestButtonAccept]}
                  onPress={onAccept}
                  hitSlop={6}
                >
                  <Ionicons name="checkmark" size={16} color={colors.tickRead} />
                </Pressable>
                <Pressable
                  style={[styles.requestButton, styles.requestButtonReject]}
                  onPress={onReject}
                  hitSlop={6}
                >
                  <Ionicons name="close" size={16} color={colors.danger} />
                </Pressable>
              </View>
            </>
          ) : item.status === "pending_outgoing" ? (
            <Text style={styles.requestLabel} numberOfLines={1}>
              Request sent
            </Text>
          ) : item.status === "declined" ? (
            <Text style={styles.requestLabel} numberOfLines={1}>
              Declined
            </Text>
          ) : (
            <>
              <View style={styles.previewRow}>
                <PreviewReceiptTick item={item} colors={colors} />
                <Text style={[styles.preview, hasUnread && styles.previewUnread]} numberOfLines={1}>
                  {item.last_message ?? "No messages yet"}
                </Text>
              </View>
              {hasUnread ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.unread_count > 99 ? "99+" : item.unread_count}</Text>
                </View>
              ) : null}
            </>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  receiptTick: { marginRight: 3 },
});

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
    empty: { color: colors.textTertiary, textAlign: "center" },
    list: { padding: 12, paddingTop: 4, gap: 10 },
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
    card: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 12,
      borderRadius: 18,
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 3,
      elevation: 1,
    },
    cardPressed: { opacity: 0.7 },
    avatar: { width: 56, height: 56, borderRadius: 28, overflow: "hidden" },
    avatarFallback: { alignItems: "center", justifyContent: "center" },
    avatarText: { fontSize: 20, fontWeight: "700", color: "#fff" },
    onlineDot: {
      position: "absolute",
      bottom: 1,
      right: 1,
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.tickRead,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    rowContent: { flex: 1 },
    rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    name: { fontSize: 16, fontWeight: "700", color: colors.text, flexShrink: 1 },
    time: { fontSize: 12, color: colors.textTertiary },
    timeUnread: { color: colors.accent, fontWeight: "600" },
    rowBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 3 },
    previewRow: { flex: 1, flexDirection: "row", alignItems: "center", marginRight: 8 },
    preview: { fontSize: 14, color: colors.textSecondary, flex: 1 },
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
    requestLabel: { flex: 1, fontSize: 14, color: colors.textTertiary, fontStyle: "italic" },
    requestActions: { flexDirection: "row", gap: 8 },
    requestButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
    },
    requestButtonAccept: { backgroundColor: colors.tickRead + "22", borderColor: colors.tickRead },
    requestButtonReject: { backgroundColor: colors.danger + "22", borderColor: colors.danger },
  });
