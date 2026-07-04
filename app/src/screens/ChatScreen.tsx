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

import type { MainStackParamList } from "../../App";
import { decryptMessage, encryptMessage, getOrCreateIdentity } from "../crypto/identity";
import {
  deleteMessage,
  getConversationById,
  getMessages,
  getUnreadIncomingMessages,
  insertMessage,
  markMessageDelivered,
  markMessageRead,
  markMessageSent,
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

function presentMessageActions(callbacks: {
  onReply: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Reply", "Copy", "Delete", "Cancel"], destructiveButtonIndex: 2, cancelButtonIndex: 3 },
      (index) => {
        if (index === 0) callbacks.onReply();
        else if (index === 1) callbacks.onCopy();
        else if (index === 2) callbacks.onDelete();
      }
    );
  } else {
    Alert.alert("Message", undefined, [
      { text: "Reply", onPress: callbacks.onReply },
      { text: "Copy", onPress: callbacks.onCopy },
      { text: "Delete", onPress: callbacks.onDelete, style: "destructive" },
      { text: "Cancel", style: "cancel" },
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
}

function MessageBubble({ message, onReply, onCopy, onDelete }: MessageBubbleProps) {
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

  return (
    <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }] }}>
      <Pressable
        style={[styles.bubble, isOutgoing ? styles.outgoing : styles.incoming]}
        onLongPress={() =>
          presentMessageActions({
            onReply: () => onReply(message),
            onCopy: () => onCopy(message),
            onDelete: () => onDelete(message),
          })
        }
      >
        {message.reply_preview ? (
          <View style={styles.replyQuote}>
            <Text style={styles.replyQuoteText} numberOfLines={1}>
              {message.reply_preview}
            </Text>
          </View>
        ) : null}
        <Text style={isOutgoing ? styles.outgoingText : styles.incomingText}>{message.plaintext}</Text>
        <Pressable style={styles.metaRow} onPress={() => showTimingInfo(message)} disabled={!isOutgoing}>
          <Text style={isOutgoing ? styles.metaTextOutgoing : styles.metaTextIncoming}>
            {formatTime(message.sent_at)}
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

  const [messages, setMessages] = useState<MessageRow[]>(() => getMessages(conversationId));
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  const listRef = useRef<FlatList<ListItem>>(null);
  const readSentRef = useRef<Set<string>>(new Set());
  const listItems = useMemo(() => buildListItems(messages), [messages]);

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
      };
      insertMessage(row);
      setMessages((prev) => [...prev, row]);
      getSocket().emit("message:delivered", { id: message.id, senderId: conversationId });
      markVisibleMessagesRead();
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

    socket.on("message", onMessage);
    socket.on("message:delivered", onDelivered);
    socket.on("message:read", onRead);
    return () => {
      socket.off("message", onMessage);
      socket.off("message:delivered", onDelivered);
      socket.off("message:read", onRead);
    };
  }, [conversation, conversationId, isTestBot, markVisibleMessagesRead]);

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
        };
        insertMessage(reply);
        setMessages((prev) => [...prev, reply]);
      }, 700);
      return;
    }

    const payload: MessagePayload = { text, replyTo: activeReply ?? undefined };
    const identity = await getOrCreateIdentity();
    await sodium.ready;
    const peerPublicKey = sodium.from_base64(conversation.peer_public_key);
    const { ciphertext, nonce } = await encryptMessage(
      JSON.stringify(payload),
      peerPublicKey,
      identity.privateKey
    );

    getSocket().emit("message:send", { id, recipientId: conversationId, ciphertext, nonce }, () => {
      markMessageSent(id);
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)));
    });
  }, [draft, conversation, conversationId, isTestBot, replyingTo]);

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
      <FlatList
        ref={listRef}
        data={listItems}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) =>
          item.type === "separator" ? (
            <View style={styles.dateSeparator}>
              <Text style={styles.dateSeparatorText}>{item.label}</Text>
            </View>
          ) : (
            <MessageBubble message={item.message} onReply={onReply} onCopy={onCopy} onDelete={onDelete} />
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

      <View style={styles.inputRow}>
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
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 8,
    gap: 8,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
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
