import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import sodium from "react-native-libsodium";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import EmojiPicker, { type EmojiType } from "rn-emoji-keyboard";

import type { MainStackParamList } from "../../App";
import { decryptMessage, encryptMessage, getOrCreateIdentity } from "../crypto/identity";
import {
  deleteMessage,
  getConversationById,
  getMessages,
  getUnreadIncomingMessages,
  insertMessage,
  markMessageDelivered,
  markMessageDeletedEverywhere,
  markMessageFailed,
  markMessagePending,
  markMessageRead,
  markMessageSent,
  pinMessage,
  unpinMessage,
  type MessageRow,
} from "../db/database";
import { getSocket } from "../network/socket";
import { TEST_BOT_CONVERSATION_ID } from "../testBot";
import { colors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "Chat">;

interface MessagePayload {
  text: string;
  replyTo?: { id: string; preview: string };
}

interface IncomingServerMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
  created_at: number;
}

interface ReplyTarget {
  id: string;
  preview: string;
}

const REPLY_PREVIEW_MAX_LENGTH = 80;
const SEND_TIMEOUT_MS = 15000;
const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 60 * 60 * 1000;

function truncate(text: string) {
  return text.length > REPLY_PREVIEW_MAX_LENGTH ? `${text.slice(0, REPLY_PREVIEW_MAX_LENGTH)}…` : text;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

type ListItem =
  | { type: "separator"; id: string; label: string }
  | { type: "message"; id: string; message: MessageRow };

function buildListItems(messages: MessageRow[]): ListItem[] {
  const items: ListItem[] = [];
  let lastLabel: string | null = null;
  for (const message of messages) {
    const label = dayLabel(message.sent_at);
    if (label !== lastLabel) {
      items.push({ type: "separator", id: `sep-${message.id}`, label });
      lastLabel = label;
    }
    items.push({ type: "message", id: message.id, message });
  }
  return items;
}

interface MessageAction {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

function presentMessageActions(actions: MessageAction[]) {
  if (Platform.OS === "ios") {
    const options = [...actions.map((a) => a.label), "Cancel"];
    const destructiveButtonIndex = actions
      .map((a, i) => (a.destructive ? i : -1))
      .filter((i) => i >= 0);
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, destructiveButtonIndex },
      (index) => {
        if (index === undefined || index === options.length - 1) return;
        actions[index]?.onPress();
      }
    );
  } else {
    Alert.alert("Message", undefined, [
      ...actions.map((a) => ({
        text: a.label,
        onPress: a.onPress,
        style: a.destructive ? ("destructive" as const) : undefined,
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }
}

function showTimingInfo(message: MessageRow) {
  const lines = [`Sent: ${formatTime(message.sent_at)}`];
  if (message.delivered_at) lines.push(`Delivered: ${formatTime(message.delivered_at)}`);
  if (message.read_at) lines.push(`Read: ${formatTime(message.read_at)}`);
  Alert.alert("Message info", lines.join("\n"));
}

function StatusTicks({ status }: { status: MessageRow["status"] }) {
  if (status === "failed") {
    return <Ionicons name="alert-circle" size={14} color={colors.danger} />;
  }
  if (status === "pending") {
    return <Ionicons name="time-outline" size={13} color="rgba(255,255,255,0.75)" />;
  }
  if (status === "sent") {
    return <Ionicons name="checkmark" size={15} color="rgba(255,255,255,0.75)" />;
  }
  if (status === "delivered") {
    return <Ionicons name="checkmark-done" size={15} color="rgba(255,255,255,0.75)" />;
  }
  return <Ionicons name="checkmark-done" size={15} color={colors.tickRead} />;
}

interface MessageBubbleProps {
  message: MessageRow;
  onReply: (message: MessageRow) => void;
  onCopy: (message: MessageRow) => void;
  onDelete: (message: MessageRow) => void;
  onRetry: (message: MessageRow) => void;
  onPin: (message: MessageRow) => void;
  onUnpin: (message: MessageRow) => void;
  onDeleteForEveryone: (message: MessageRow) => void;
}

function MessageBubble({
  message,
  onReply,
  onCopy,
  onDelete,
  onRetry,
  onPin,
  onUnpin,
  onDeleteForEveryone,
}: MessageBubbleProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const replyTriggered = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_evt, gesture) => {
        const clamped = Math.max(-70, Math.min(70, gesture.dx));
        translateX.setValue(clamped);
        if (!replyTriggered.current && Math.abs(clamped) > 60) {
          replyTriggered.current = true;
        }
      },
      onPanResponderRelease: () => {
        if (replyTriggered.current) {
          onReply(message);
        }
        replyTriggered.current = false;
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => {
        replyTriggered.current = false;
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  ).current;

  const isOutgoing = message.direction === "outgoing";
  const isDeleted = !!message.deleted_at;
  const isPinned = !!message.pinned_at;
  const canDeleteForEveryone =
    isOutgoing && !isDeleted && Date.now() - message.sent_at <= DELETE_FOR_EVERYONE_WINDOW_MS;

  const onLongPress = isDeleted
    ? undefined
    : () => {
        const actions: MessageAction[] = [
          { label: "Reply", onPress: () => onReply(message) },
          { label: "Copy", onPress: () => onCopy(message) },
          {
            label: isPinned ? "Unpin" : "Pin",
            onPress: () => (isPinned ? onUnpin(message) : onPin(message)),
          },
        ];
        if (canDeleteForEveryone) {
          actions.push({
            label: "Delete for everyone",
            destructive: true,
            onPress: () => onDeleteForEveryone(message),
          });
        }
        actions.push({ label: "Delete for me", destructive: true, onPress: () => onDelete(message) });
        presentMessageActions(actions);
      };

  return (
    <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
      <Pressable
        style={[styles.bubble, isOutgoing ? styles.outgoing : styles.incoming]}
        onLongPress={onLongPress}
      >
        {isDeleted ? (
          <View style={styles.deletedRow}>
            <Ionicons
              name="ban-outline"
              size={14}
              color={isOutgoing ? "rgba(255,255,255,0.75)" : colors.textTertiary}
            />
            <Text style={isOutgoing ? styles.outgoingDeletedText : styles.incomingDeletedText}>
              This message was deleted
            </Text>
          </View>
        ) : (
          <>
            {message.reply_preview ? (
              <View style={styles.replyQuote}>
                <Text style={styles.replyQuoteText} numberOfLines={1}>
                  {message.reply_preview}
                </Text>
              </View>
            ) : null}
            <Text style={isOutgoing ? styles.outgoingText : styles.incomingText}>{message.plaintext}</Text>
          </>
        )}
        <Pressable
          style={styles.metaRow}
          onPress={() => (message.status === "failed" ? onRetry(message) : showTimingInfo(message))}
          disabled={!isOutgoing || isDeleted}
        >
          {isPinned ? (
            <Ionicons
              name="pin"
              size={11}
              color={isOutgoing ? "rgba(255,255,255,0.75)" : colors.textTertiary}
            />
          ) : null}
          <Text style={isOutgoing ? styles.metaTextOutgoing : styles.metaTextIncoming}>
            {message.status === "failed" ? "Not sent · tap to retry" : formatTime(message.sent_at)}
          </Text>
          {isOutgoing ? <StatusTicks status={message.status} /> : null}
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

export default function ChatScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const conversation = getConversationById(conversationId);
  const isTestBot = conversationId === TEST_BOT_CONVERSATION_ID;
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<MessageRow[]>(() => getMessages(conversationId));
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const listRef = useRef<FlatList<ListItem>>(null);
  const readSentRef = useRef<Set<string>>(new Set());
  const listItems = useMemo(() => buildListItems(messages), [messages]);
  const pinnedMessage = useMemo(() => messages.find((m) => m.pinned_at) ?? null, [messages]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: conversation?.display_name ?? "Chat" });
  }, [navigation, conversation?.display_name]);

  const markVisibleMessagesRead = useCallback(() => {
    if (!conversation || isTestBot) return;
    const unread = getUnreadIncomingMessages(conversationId);
    if (unread.length === 0) return;

    const now = Date.now();
    let changed = false;
    for (const row of unread) {
      if (readSentRef.current.has(row.id)) continue;
      readSentRef.current.add(row.id);
      markMessageRead(row.id, now);
      getSocket().emit("message:read", { id: row.id, senderId: conversationId });
      changed = true;
    }
    if (changed) {
      setMessages(getMessages(conversationId));
    }
  }, [conversation, conversationId, isTestBot]);

  useFocusEffect(
    useCallback(() => {
      markVisibleMessagesRead();
    }, [markVisibleMessagesRead])
  );

  useEffect(() => {
    if (!conversation || isTestBot) return;
    const socket = getSocket();

    const onMessage = async (message: IncomingServerMessage) => {
      if (message.sender_id !== conversationId) return;

      try {
        const identity = await getOrCreateIdentity();
        await sodium.ready;
        const peerPublicKey = sodium.from_base64(conversation.peer_public_key);
        const decrypted = await decryptMessage(
          message.ciphertext,
          message.nonce,
          peerPublicKey,
          identity.privateKey
        );
        const payload: MessagePayload = JSON.parse(decrypted);

        const row: MessageRow = {
          id: message.id,
          conversation_id: conversationId,
          direction: "incoming",
          plaintext: payload.text,
          sent_at: message.created_at,
          status: "delivered",
          delivered_at: message.created_at,
          read_at: null,
          reply_to_id: payload.replyTo?.id ?? null,
          reply_preview: payload.replyTo?.preview ?? null,
          pinned_at: null,
          deleted_at: null,
        };
        insertMessage(row);
        setMessages((prev) => [...prev, row]);
        getSocket().emit("message:delivered", { id: message.id, senderId: conversationId });
        markVisibleMessagesRead();
      } catch (err) {
        console.warn("[chat] failed to process incoming message", err);
      }
    };

    const onDelivered = ({ id, deliveredAt }: { id: string; deliveredAt: number }) => {
      markMessageDelivered(id, deliveredAt);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id && (m.status === "pending" || m.status === "sent")
            ? { ...m, status: "delivered", delivered_at: deliveredAt }
            : m
        )
      );
    };

    const onRead = ({ id, readAt }: { id: string; readAt: number }) => {
      markMessageRead(id, readAt);
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "read", read_at: readAt } : m)));
    };

    const onDeletedRemote = ({ id }: { id: string }) => {
      const deletedAt = Date.now();
      markMessageDeletedEverywhere(id, deletedAt);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, deleted_at: deletedAt, plaintext: "", reply_preview: null, pinned_at: null } : m
        )
      );
    };

    socket.on("message", onMessage);
    socket.on("message:delivered", onDelivered);
    socket.on("message:read", onRead);
    socket.on("message:deleted", onDeletedRemote);
    return () => {
      socket.off("message", onMessage);
      socket.off("message:delivered", onDelivered);
      socket.off("message:read", onRead);
      socket.off("message:deleted", onDeletedRemote);
    };
  }, [conversation, conversationId, isTestBot, markVisibleMessagesRead]);

  const sendEncrypted = useCallback(
    async (id: string, text: string, replyTo: ReplyTarget | null) => {
      if (!conversation) return;
      try {
        const payload: MessagePayload = { text, replyTo: replyTo ?? undefined };
        const identity = await getOrCreateIdentity();
        await sodium.ready;
        const peerPublicKey = sodium.from_base64(conversation.peer_public_key);
        const { ciphertext, nonce } = await encryptMessage(
          JSON.stringify(payload),
          peerPublicKey,
          identity.privateKey
        );

        getSocket()
          .timeout(SEND_TIMEOUT_MS)
          .emit(
            "message:send",
            { id, recipientId: conversationId, ciphertext, nonce },
            (err: unknown, response?: { ok: boolean; error?: string }) => {
              if (err || !response?.ok) {
                markMessageFailed(id);
                setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "failed" } : m)));
                return;
              }
              markMessageSent(id);
              setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)));
            }
          );
      } catch (err) {
        console.warn("[chat] failed to send message", err);
        markMessageFailed(id);
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "failed" } : m)));
      }
    },
    [conversation, conversationId]
  );

  const onRetry = useCallback(
    (message: MessageRow) => {
      markMessagePending(message.id);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, status: "pending" } : m)));
      const replyTo = message.reply_to_id
        ? { id: message.reply_to_id, preview: message.reply_preview ?? "" }
        : null;
      void sendEncrypted(message.id, message.plaintext, replyTo);
    },
    [sendEncrypted]
  );

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !conversation) return;
    setDraft("");
    const activeReply = replyingTo;
    setReplyingTo(null);

    const id = Crypto.randomUUID();
    const outgoing: MessageRow = {
      id,
      conversation_id: conversationId,
      direction: "outgoing",
      plaintext: text,
      sent_at: Date.now(),
      status: "pending",
      delivered_at: null,
      read_at: null,
      reply_to_id: activeReply?.id ?? null,
      reply_preview: activeReply?.preview ?? null,
      pinned_at: null,
      deleted_at: null,
    };
    insertMessage(outgoing);
    setMessages((prev) => [...prev, outgoing]);

    if (isTestBot) {
      markMessageSent(id);
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)));

      setTimeout(() => {
        const deliveredAt = Date.now();
        markMessageDelivered(id, deliveredAt);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, status: "delivered", delivered_at: deliveredAt } : m))
        );
      }, 300);

      setTimeout(() => {
        const readAt = Date.now();
        markMessageRead(id, readAt);
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "read", read_at: readAt } : m)));

        const reply: MessageRow = {
          id: Crypto.randomUUID(),
          conversation_id: conversationId,
          direction: "incoming",
          plaintext: `Echo: ${text}`,
          sent_at: Date.now(),
          status: "delivered",
          delivered_at: Date.now(),
          read_at: null,
          reply_to_id: null,
          reply_preview: null,
          pinned_at: null,
          deleted_at: null,
        };
        insertMessage(reply);
        setMessages((prev) => [...prev, reply]);
      }, 700);
      return;
    }

    void sendEncrypted(id, text, activeReply);
  }, [draft, conversation, conversationId, isTestBot, replyingTo, sendEncrypted]);

  const onCopy = useCallback((message: MessageRow) => {
    Clipboard.setStringAsync(message.plaintext);
  }, []);

  const onDelete = useCallback((message: MessageRow) => {
    deleteMessage(message.id);
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
  }, []);

  const onReply = useCallback((message: MessageRow) => {
    setReplyingTo({ id: message.id, preview: truncate(message.plaintext) });
  }, []);

  const onPin = useCallback(
    (message: MessageRow) => {
      pinMessage(conversationId, message.id);
      const pinnedAt = Date.now();
      setMessages((prev) => prev.map((m) => ({ ...m, pinned_at: m.id === message.id ? pinnedAt : null })));
    },
    [conversationId]
  );

  const onUnpin = useCallback((message: MessageRow) => {
    unpinMessage(message.id);
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, pinned_at: null } : m)));
  }, []);

  const onDeleteForEveryone = useCallback(
    (message: MessageRow) => {
      if (isTestBot) return;
      getSocket()
        .timeout(SEND_TIMEOUT_MS)
        .emit(
          "message:delete",
          { id: message.id },
          (err: unknown, response?: { ok: boolean; error?: string }) => {
            if (err || !response?.ok) {
              Alert.alert(
                "Couldn't delete",
                response?.error === "too_late"
                  ? "This message is too old to delete for everyone (2 hour limit)."
                  : "Please try again."
              );
              return;
            }
            const deletedAt = Date.now();
            markMessageDeletedEverywhere(message.id, deletedAt);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === message.id
                  ? { ...m, deleted_at: deletedAt, plaintext: "", reply_preview: null, pinned_at: null }
                  : m
              )
            );
          }
        );
    },
    [isTestBot]
  );

  const scrollToMessage = useCallback(
    (id: string) => {
      const index = listItems.findIndex((item) => item.id === id);
      if (index >= 0) listRef.current?.scrollToIndex({ index, animated: true });
    },
    [listItems]
  );

  if (!conversation) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>Conversation not found.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {pinnedMessage ? (
        <Pressable style={styles.pinnedBanner} onPress={() => scrollToMessage(pinnedMessage.id)}>
          <Ionicons name="pin" size={14} color={colors.accent} />
          <View style={styles.pinnedBannerText}>
            <Text style={styles.pinnedBannerLabel}>Pinned message</Text>
            <Text numberOfLines={1} style={styles.pinnedBannerPreview}>
              {pinnedMessage.plaintext}
            </Text>
          </View>
          <Pressable onPress={() => onUnpin(pinnedMessage)} hitSlop={8}>
            <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
          </Pressable>
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        data={listItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        onScrollToIndexFailed={({ averageItemLength, index }) =>
          listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: true })
        }
        renderItem={({ item }) =>
          item.type === "separator" ? (
            <View style={styles.dateSeparator}>
              <Text style={styles.dateSeparatorText}>{item.label}</Text>
            </View>
          ) : (
            <MessageBubble
              message={item.message}
              onReply={onReply}
              onCopy={onCopy}
              onDelete={onDelete}
              onRetry={onRetry}
              onPin={onPin}
              onUnpin={onUnpin}
              onDeleteForEveryone={onDeleteForEveryone}
            />
          )
        }
      />

      {replyingTo ? (
        <View style={styles.replyBanner}>
          <View style={styles.replyBannerText}>
            <Text style={styles.replyBannerLabel}>Replying to</Text>
            <Text numberOfLines={1} style={styles.replyBannerPreview}>
              {replyingTo.preview}
            </Text>
          </View>
          <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
            <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.inputRow, { paddingBottom: 8 + insets.bottom }]}>
        <Pressable style={styles.emojiButton} onPress={() => setEmojiPickerOpen(true)} hitSlop={8}>
          <Ionicons name="happy-outline" size={24} color={colors.textSecondary} />
        </Pressable>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          multiline
        />
        <Pressable
          style={[styles.sendButton, !draft.trim() && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={!draft.trim()}
        >
          <Ionicons name="arrow-up" size={20} color={draft.trim() ? "#fff" : colors.accent} />
        </Pressable>
      </View>

      <EmojiPicker
        open={emojiPickerOpen}
        onClose={() => setEmojiPickerOpen(false)}
        onEmojiSelected={(emoji: EmojiType) => setDraft((prev) => prev + emoji.emoji)}
        enableSearchBar
        enableRecentlyUsed
        categoryPosition="floating"
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  missing: { color: colors.textTertiary },
  list: { padding: 12, gap: 6 },
  dateSeparator: { alignItems: "center", marginVertical: 10 },
  dateSeparatorText: {
    fontSize: 12,
    color: colors.textSecondary,
    backgroundColor: "rgba(120,120,128,0.12)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    overflow: "hidden",
  },
  bubble: {
    maxWidth: "80%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
  },
  outgoing: { alignSelf: "flex-end", backgroundColor: colors.accent, borderBottomRightRadius: 4 },
  incoming: { alignSelf: "flex-start", backgroundColor: colors.bubbleIncoming, borderBottomLeftRadius: 4 },
  outgoingText: { color: "#fff", fontSize: 15.5 },
  incomingText: { color: colors.text, fontSize: 15.5 },
  deletedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  outgoingDeletedText: { color: "rgba(255,255,255,0.75)", fontSize: 15, fontStyle: "italic" },
  incomingDeletedText: { color: colors.textTertiary, fontSize: 15, fontStyle: "italic" },
  replyQuote: {
    borderLeftWidth: 3,
    borderLeftColor: "rgba(255,255,255,0.6)",
    paddingLeft: 6,
    marginBottom: 4,
  },
  replyQuoteText: { fontSize: 12, color: "rgba(0,0,0,0.55)", fontStyle: "italic" },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", marginTop: 4, gap: 4 },
  metaTextOutgoing: { fontSize: 11, color: "rgba(255,255,255,0.8)" },
  metaTextIncoming: { fontSize: 11, color: colors.textSecondary },
  replyBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  replyBannerText: { flex: 1, marginRight: 8 },
  replyBannerLabel: { fontSize: 11, color: colors.accent, fontWeight: "600" },
  replyBannerPreview: { fontSize: 13, color: colors.text },
  pinnedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pinnedBannerText: { flex: 1 },
  pinnedBannerLabel: { fontSize: 11, color: colors.accent, fontWeight: "600" },
  pinnedBannerPreview: { fontSize: 13, color: colors.text },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 8,
    gap: 8,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  emojiButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15.5,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.accent,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: { backgroundColor: colors.accentSoft },
});
