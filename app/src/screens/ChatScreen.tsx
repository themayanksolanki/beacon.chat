import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
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
import * as ImagePicker from "expo-image-picker";
import sodium from "react-native-libsodium";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import EmojiPicker, { type EmojiType } from "rn-emoji-keyboard";

import type { MainStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import { useVoiceRecorder, type RecordedVoice } from "../audio/useVoiceRecorder";
import { clearConversation } from "../chat/clearConversation";
import { deleteConversation } from "../chat/deleteConversation";
import { persistRecordedVoice, readVoiceMessageBase64 } from "../audio/voiceStorage";
import ImageMessageBubble from "../components/ImageMessageBubble";
import MessageActionMenu, { type MessageAction, type MessageMenuAnchor } from "../components/MessageActionMenu";
import VoiceMessageBubble from "../components/VoiceMessageBubble";
import { encryptMessage, getOrCreateIdentity } from "../crypto/identity";
import {
  blockUser,
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
  setMyReaction,
  unpinMessage,
  type MessageRow,
} from "../db/database";
import { compressImage } from "../media/imageCompression";
import { deleteImageMessage, persistPickedImage, readImageMessageBase64 } from "../media/imageStorage";
import { useCall } from "../calls/CallContext";
import { getSocket } from "../network/socket";
import { useMessaging, type MessagePayload, type ReactionPayload } from "../messaging/MessagingContext";
import { setActiveConversationId } from "../notifications/activeChatTracker";
import { clearNotificationsForConversation } from "../notifications/notificationService";
import { usePresence } from "../presence/PresenceContext";
import { TEST_BOT_CONVERSATION_ID } from "../testBot";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

const VOICE_MESSAGE_LABEL = "🎤 Voice message";
const IMAGE_MESSAGE_LABEL = "📷 Photo";

type Props = NativeStackScreenProps<MainStackParamList, "Chat">;

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

function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function formatLastSeen(ts: number): string {
  const label = dayLabel(ts);
  if (label === "Today") return `last seen today at ${formatTime(ts)}`;
  if (label === "Yesterday") return `last seen yesterday at ${formatTime(ts)}`;
  return `last seen ${label}`;
}

function ChatHeaderTitle({
  name,
  online,
  lastSeenAt,
  onPress,
}: {
  name: string;
  online: boolean;
  lastSeenAt: number | null;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Pressable
      style={({ pressed }) => [styles.headerTitleRow, pressed && styles.headerTitleRowPressed]}
      onPress={onPress}
      hitSlop={8}
    >
      <View style={styles.headerAvatarWrap}>
        <View style={[styles.headerAvatar, { backgroundColor: colorForName(name) }]}>
          <Text style={styles.headerAvatarText}>{initialFor(name)}</Text>
        </View>
        {online ? <View style={styles.headerOnlineDot} /> : null}
      </View>
      <View style={styles.headerTextCol}>
        <Text style={styles.headerName} numberOfLines={1}>
          {name}
        </Text>
        {online ? (
          <Text style={styles.headerStatusOnline} numberOfLines={1}>
            Active now
          </Text>
        ) : lastSeenAt ? (
          <Text style={styles.headerStatus} numberOfLines={1}>
            {formatLastSeen(lastSeenAt)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function ChatHeaderCallButtons({ conversationId }: { conversationId: string }) {
  const { colors } = useTheme();
  const { startCall } = useCall();

  return (
    <View style={{ flexDirection: "row", gap: 18 }}>
      <Pressable onPress={() => startCall(conversationId, "audio")} hitSlop={8}>
        <Ionicons name="call-outline" size={22} color={colors.accent} />
      </Pressable>
      <Pressable onPress={() => startCall(conversationId, "video")} hitSlop={8}>
        <Ionicons name="videocam-outline" size={24} color={colors.accent} />
      </Pressable>
    </View>
  );
}

function ChatHeaderOptionsButton({
  onClearChat,
  onDeleteChat,
  onBlockUser,
  onDeleteUser,
}: {
  onClearChat: () => void;
  onDeleteChat: () => void;
  onBlockUser: () => void;
  onDeleteUser: () => void;
}) {
  const { colors } = useTheme();
  const buttonRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<MessageMenuAnchor | null>(null);
  const [visible, setVisible] = useState(false);

  const actions: MessageAction[] = [
    { label: "Clear Chat", icon: "brush-outline", destructive: true, onPress: onClearChat },
    { label: "Delete Chat", icon: "trash-outline", destructive: true, onPress: onDeleteChat },
    { label: "Block User", icon: "ban-outline", destructive: true, onPress: onBlockUser },
    { label: "Delete User", icon: "person-remove-outline", destructive: true, onPress: onDeleteUser },
  ];

  const showOptions = () => {
    buttonRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      setVisible(true);
    });
  };

  return (
    <>
      <Pressable ref={buttonRef} onPress={showOptions} hitSlop={8} style={{ marginLeft: 18 }}>
        <Ionicons name="ellipsis-vertical" size={20} color={colors.accent} />
      </Pressable>
      <MessageActionMenu visible={visible} anchor={anchor} actions={actions} onClose={() => setVisible(false)} />
    </>
  );
}

type ListItem =
  | { type: "separator"; id: string; label: string }
  | { type: "message"; id: string; message: MessageRow; isGroupEnd: boolean };

/**
 * Consecutive messages from the same side are visually grouped (tighter
 * spacing, tail corner only on the last one) — a day boundary or a change
 * in direction always ends a group.
 */
function buildListItems(messages: MessageRow[]): ListItem[] {
  const items: ListItem[] = [];
  let lastLabel: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const label = dayLabel(message.sent_at);
    if (label !== lastLabel) {
      items.push({ type: "separator", id: `sep-${message.id}`, label });
      lastLabel = label;
    }
    const next = messages[i + 1];
    const isGroupEnd = !next || next.direction !== message.direction || dayLabel(next.sent_at) !== label;
    items.push({ type: "message", id: message.id, message, isGroupEnd });
  }
  return items;
}

function showTimingInfo(message: MessageRow) {
  const lines = [`Sent: ${formatTime(message.sent_at)}`];
  if (message.delivered_at) lines.push(`Delivered: ${formatTime(message.delivered_at)}`);
  if (message.read_at) lines.push(`Read: ${formatTime(message.read_at)}`);
  Alert.alert("Message info", lines.join("\n"));
}

function StatusTicks({ status }: { status: MessageRow["status"] }) {
  const { colors } = useTheme();
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
  isGroupEnd: boolean;
  onReply: (message: MessageRow) => void;
  onCopy: (message: MessageRow) => void;
  onDelete: (message: MessageRow) => void;
  onRetry: (message: MessageRow) => void;
  onPin: (message: MessageRow) => void;
  onUnpin: (message: MessageRow) => void;
  onDeleteForEveryone: (message: MessageRow) => void;
  onOpenMenu: (message: MessageRow, actions: MessageAction[], anchor: MessageMenuAnchor) => void;
  onCancelSend: (message: MessageRow) => void;
}

function MessageBubble({
  message,
  isGroupEnd,
  onReply,
  onCopy,
  onDelete,
  onRetry,
  onPin,
  onUnpin,
  onDeleteForEveryone,
  onOpenMenu,
  onCancelSend,
}: MessageBubbleProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const translateX = useRef(new Animated.Value(0)).current;
  const replyTriggered = useRef(false);
  const bubbleRef = useRef<View>(null);

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
  const hasReaction = !isDeleted && !!(message.reaction_mine || message.reaction_peer);

  const onLongPress = isDeleted
    ? undefined
    : () => {
        const actions: MessageAction[] = [
          { label: "Reply", icon: "arrow-undo-outline", onPress: () => onReply(message) },
          { label: "Copy", icon: "copy-outline", onPress: () => onCopy(message) },
        ];
        if (isOutgoing) {
          actions.push({
            label: "Info",
            icon: "information-circle-outline",
            onPress: () => showTimingInfo(message),
          });
        }
        actions.push({
          label: isPinned ? "Unpin" : "Pin",
          icon: isPinned ? "pin" : "pin-outline",
          onPress: () => (isPinned ? onUnpin(message) : onPin(message)),
        });
        if (canDeleteForEveryone) {
          actions.push({
            label: "Delete for everyone",
            icon: "trash-outline",
            destructive: true,
            onPress: () => onDeleteForEveryone(message),
          });
        }
        actions.push({
          label: "Delete for me",
          icon: "trash-outline",
          destructive: true,
          onPress: () => onDelete(message),
        });

        bubbleRef.current?.measureInWindow((x, y, width, height) => {
          onOpenMenu(message, actions, { x, y, width, height });
        });
      };

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        { transform: [{ translateX }] },
        hasReaction ? styles.bubbleRowReacted : isGroupEnd ? styles.bubbleRowSpaced : styles.bubbleRowTight,
      ]}
    >
      <View style={{ alignSelf: isOutgoing ? "flex-end" : "flex-start" }}>
        <Pressable
          ref={bubbleRef}
          style={[
            styles.bubble,
            isOutgoing ? styles.outgoing : styles.incoming,
            !isGroupEnd && (isOutgoing ? styles.outgoingGrouped : styles.incomingGrouped),
          ]}
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
                <View
                  style={[styles.replyQuote, isOutgoing ? styles.replyQuoteOutgoing : styles.replyQuoteIncoming]}
                >
                  <Text
                    style={isOutgoing ? styles.replyQuoteTextOutgoing : styles.replyQuoteTextIncoming}
                    numberOfLines={1}
                  >
                    {message.reply_preview}
                  </Text>
                </View>
              ) : null}
              {message.kind === "voice" ? (
                <VoiceMessageBubble
                  audioUri={message.audio_uri}
                  durationMs={message.duration_ms ?? 0}
                  waveform={message.waveform ? JSON.parse(message.waveform) : []}
                  isOutgoing={isOutgoing}
                />
              ) : message.kind === "image" ? (
                <ImageMessageBubble
                  imageUri={message.image_uri}
                  width={message.image_width ?? 0}
                  height={message.image_height ?? 0}
                  isSending={isOutgoing && message.status === "pending"}
                  onCancelSend={
                    isOutgoing && message.status === "pending" ? () => onCancelSend(message) : undefined
                  }
                />
              ) : (
                <Text style={isOutgoing ? styles.outgoingText : styles.incomingText}>{message.plaintext}</Text>
              )}
            </>
          )}
          <Pressable
            style={styles.metaRow}
            onPress={() => onRetry(message)}
            disabled={message.status !== "failed"}
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

        {!isDeleted && (message.reaction_mine || message.reaction_peer) ? (
          <View style={[styles.reactionBadge, isOutgoing ? styles.reactionBadgeOutgoing : styles.reactionBadgeIncoming]}>
            <Text style={styles.reactionBadgeText}>
              {Array.from(new Set([message.reaction_mine, message.reaction_peer].filter(Boolean))).join(" ")}
            </Text>
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

export default function ChatScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const { email } = useAuth();
  const conversation = useMemo(() => getConversationById(conversationId), [conversationId]);
  const isTestBot = conversationId === TEST_BOT_CONVERSATION_ID;
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [messages, setMessages] = useState<MessageRow[]>(() => getMessages(conversationId));
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [menu, setMenu] = useState<{
    message: MessageRow;
    actions: MessageAction[];
    anchor: MessageMenuAnchor;
  } | null>(null);
  const listRef = useRef<FlatList<ListItem>>(null);
  const readSentRef = useRef<Set<string>>(new Set());
  const listItems = useMemo(() => buildListItems(messages), [messages]);
  const pinnedMessage = useMemo(() => messages.find((m) => m.pinned_at) ?? null, [messages]);

  const openMenu = useCallback(
    (message: MessageRow, actions: MessageAction[], anchor: MessageMenuAnchor) => {
      setMenu({ message, actions, anchor });
    },
    []
  );

  const { presence, subscribe } = usePresence();
  useEffect(() => {
    if (!isTestBot) subscribe([conversationId]);
  }, [conversationId, isTestBot, subscribe]);

  const peerPresence = presence[conversationId];

  const onClearChat = useCallback(() => {
    const name = conversation?.display_name ?? "this contact";
    Alert.alert("Clear chat", `Delete all messages with ${name}? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          clearConversation(conversationId);
          setMessages([]);
        },
      },
    ]);
  }, [conversationId, conversation?.display_name]);

  const onDeleteChat = useCallback(() => {
    deleteConversation(conversationId);
    navigation.goBack();
  }, [conversationId, navigation]);

  const onBlockUser = useCallback(() => {
    blockUser(conversationId);
  }, [conversationId]);

  const onDeleteUser = useCallback(() => {
    blockUser(conversationId);
    deleteConversation(conversationId);
    navigation.goBack();
  }, [conversationId, navigation]);

  useLayoutEffect(() => {
    const name = conversation?.display_name ?? "Chat";
    navigation.setOptions({
      title: name,
      // setOptions merges into whatever was set before rather than replacing
      // it wholesale, so headerLeft must be explicitly reset here — otherwise
      // a stale custom value from an earlier options call (e.g. during a dev
      // Fast Refresh) keeps overriding the default back chevron indefinitely.
      headerLeft: undefined,
      headerTitle: isTestBot
        ? undefined
        : () => (
            <ChatHeaderTitle
              name={name}
              online={peerPresence?.online ?? false}
              lastSeenAt={peerPresence?.lastSeenAt ?? null}
              onPress={() => navigation.navigate("ContactInfo", { conversationId })}
            />
          ),
      headerRight: isTestBot
        ? undefined
        : () => (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <ChatHeaderCallButtons conversationId={conversationId} />
              <ChatHeaderOptionsButton
                onClearChat={onClearChat}
                onDeleteChat={onDeleteChat}
                onBlockUser={onBlockUser}
                onDeleteUser={onDeleteUser}
              />
            </View>
          ),
    });
  }, [
    navigation,
    conversation?.display_name,
    isTestBot,
    peerPresence,
    conversationId,
    onClearChat,
    onDeleteChat,
    onBlockUser,
    onDeleteUser,
  ]);

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
      getSocket().emit("message:read", { id: row.id });
      changed = true;
    }
    if (changed) {
      setMessages(getMessages(conversationId));
    }
  }, [conversation, conversationId, isTestBot]);

  useFocusEffect(
    useCallback(() => {
      setMessages(getMessages(conversationId));
      markVisibleMessagesRead();
    }, [conversationId, markVisibleMessagesRead])
  );

  // Notification suppression (see notificationService.ts) keys off this: a
  // message for whichever conversation is "active" here is treated as
  // already seen and doesn't produce a notification. Cleared on blur so
  // backgrounding the app or navigating away doesn't leave a stale chat
  // marked active.
  useFocusEffect(
    useCallback(() => {
      setActiveConversationId(conversationId);
      void clearNotificationsForConversation(conversationId);
      return () => setActiveConversationId(null);
    }, [conversationId])
  );

  // Incoming messages/receipts/reactions are decrypted and persisted globally
  // by MessagingProvider regardless of which chat is open — this screen just
  // re-reads from the local DB whenever that happens, and marks messages read
  // if this conversation happens to be the one currently focused.
  const { revision } = useMessaging();
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!conversation || isTestBot) return;
    setMessages(getMessages(conversationId));
    if (isFocused) markVisibleMessagesRead();
  }, [revision, conversation, conversationId, isTestBot, isFocused, markVisibleMessagesRead]);

  // Ids of pending sends the user cancelled locally (image uploads, via the
  // bubble's cross button) — the socket ack for these may still arrive after
  // the message row is already gone, and must be ignored rather than reviving it.
  const cancelledSendIdsRef = useRef<Set<string>>(new Set());

  const sendPayload = useCallback(
    async (id: string, payload: MessagePayload) => {
      if (!conversation || !email) return;
      try {
        const identity = await getOrCreateIdentity(email);
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
              if (cancelledSendIdsRef.current.delete(id)) return;
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
        if (cancelledSendIdsRef.current.delete(id)) return;
        console.warn("[chat] failed to send message", err);
        markMessageFailed(id);
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "failed" } : m)));
      }
    },
    [conversation, conversationId, email]
  );

  const sendEncrypted = useCallback(
    (id: string, text: string, replyTo: ReplyTarget | null) =>
      sendPayload(id, { kind: "text", text, replyTo: replyTo ?? undefined }),
    [sendPayload]
  );

  const sendVoiceEncrypted = useCallback(
    (id: string, audioUri: string, durationMs: number, waveform: number[], replyTo: ReplyTarget | null) =>
      sendPayload(id, {
        kind: "voice",
        audio: readVoiceMessageBase64(audioUri),
        durationMs,
        waveform,
        replyTo: replyTo ?? undefined,
      }),
    [sendPayload]
  );

  const sendImageEncrypted = useCallback(
    (id: string, imageUri: string, width: number, height: number, replyTo: ReplyTarget | null) =>
      sendPayload(id, {
        kind: "image",
        image: readImageMessageBase64(imageUri),
        width,
        height,
        replyTo: replyTo ?? undefined,
      }),
    [sendPayload]
  );

  const onCancelSend = useCallback((message: MessageRow) => {
    cancelledSendIdsRef.current.add(message.id);
    deleteMessage(message.id);
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    if (message.image_uri) deleteImageMessage(message.image_uri);
  }, []);

  const onRetry = useCallback(
    (message: MessageRow) => {
      markMessagePending(message.id);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, status: "pending" } : m)));
      const replyTo = message.reply_to_id
        ? { id: message.reply_to_id, preview: message.reply_preview ?? "" }
        : null;
      if (message.kind === "voice" && message.audio_uri) {
        void sendVoiceEncrypted(
          message.id,
          message.audio_uri,
          message.duration_ms ?? 0,
          message.waveform ? JSON.parse(message.waveform) : [],
          replyTo
        );
      } else if (message.kind === "image" && message.image_uri) {
        void sendImageEncrypted(
          message.id,
          message.image_uri,
          message.image_width ?? 0,
          message.image_height ?? 0,
          replyTo
        );
      } else {
        void sendEncrypted(message.id, message.plaintext, replyTo);
      }
    },
    [sendEncrypted, sendVoiceEncrypted, sendImageEncrypted]
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
      reaction_mine: null,
      reaction_peer: null,
      kind: "text",
      audio_uri: null,
      duration_ms: null,
      waveform: null,
      image_uri: null,
      image_width: null,
      image_height: null,
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
          reaction_mine: null,
          reaction_peer: null,
          kind: "text",
          audio_uri: null,
          duration_ms: null,
          waveform: null,
          image_uri: null,
          image_width: null,
          image_height: null,
        };
        insertMessage(reply);
        setMessages((prev) => [...prev, reply]);
      }, 700);
      return;
    }

    void sendEncrypted(id, text, activeReply);
  }, [draft, conversation, conversationId, isTestBot, replyingTo, sendEncrypted]);

  const onVoiceRecorded = useCallback(
    async ({ uri, durationMs, waveform }: RecordedVoice) => {
      if (!conversation) return;
      const activeReply = replyingTo;
      setReplyingTo(null);

      const id = Crypto.randomUUID();
      const persistedUri = await persistRecordedVoice(uri, id);
      const outgoing: MessageRow = {
        id,
        conversation_id: conversationId,
        direction: "outgoing",
        plaintext: VOICE_MESSAGE_LABEL,
        sent_at: Date.now(),
        status: "pending",
        delivered_at: null,
        read_at: null,
        reply_to_id: activeReply?.id ?? null,
        reply_preview: activeReply?.preview ?? null,
        pinned_at: null,
        deleted_at: null,
        reaction_mine: null,
        reaction_peer: null,
        kind: "voice",
        audio_uri: persistedUri,
        duration_ms: durationMs,
        waveform: JSON.stringify(waveform),
        image_uri: null,
        image_width: null,
        image_height: null,
      };
      insertMessage(outgoing);
      setMessages((prev) => [...prev, outgoing]);

      if (isTestBot) {
        markMessageSent(id);
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)));
        return;
      }

      void sendVoiceEncrypted(id, persistedUri, durationMs, waveform, activeReply);
    },
    [conversation, conversationId, isTestBot, replyingTo, sendVoiceEncrypted]
  );

  const voiceRecorder = useVoiceRecorder(onVoiceRecorded);

  const sendImage = useCallback(
    async (uri: string, width: number, height: number) => {
      if (!conversation) return;
      const activeReply = replyingTo;
      setReplyingTo(null);

      const id = Crypto.randomUUID();
      try {
        const compressed = await compressImage(uri, width, height);
        const persistedUri = await persistPickedImage(compressed.uri, id);

        const outgoing: MessageRow = {
          id,
          conversation_id: conversationId,
          direction: "outgoing",
          plaintext: IMAGE_MESSAGE_LABEL,
          sent_at: Date.now(),
          status: "pending",
          delivered_at: null,
          read_at: null,
          reply_to_id: activeReply?.id ?? null,
          reply_preview: activeReply?.preview ?? null,
          pinned_at: null,
          deleted_at: null,
          reaction_mine: null,
          reaction_peer: null,
          kind: "image",
          audio_uri: null,
          duration_ms: null,
          waveform: null,
          image_uri: persistedUri,
          image_width: compressed.width,
          image_height: compressed.height,
        };
        insertMessage(outgoing);
        setMessages((prev) => [...prev, outgoing]);

        if (isTestBot) {
          markMessageSent(id);
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)));
          return;
        }

        void sendImageEncrypted(id, persistedUri, compressed.width, compressed.height, activeReply);
      } catch (err) {
        console.warn("[chat] failed to prepare image for sending", err);
        Alert.alert("Couldn't send photo", "Please try again.");
      }
    },
    [conversation, conversationId, isTestBot, replyingTo, sendImageEncrypted]
  );

  const pickImage = useCallback(
    async (source: "camera" | "library") => {
      if (!conversation) return;
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          source === "camera" ? "Camera access needed" : "Photo access needed",
          "Enable access in Settings to share photos."
        );
        return;
      }

      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });

      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      await sendImage(asset.uri, asset.width, asset.height);
    },
    [conversation, sendImage]
  );

  const showImageSourceOptions = useCallback(() => {
    Alert.alert("Send Photo", undefined, [
      { text: "Take Photo", onPress: () => void pickImage("camera") },
      { text: "Choose from Library", onPress: () => void pickImage("library") },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [pickImage]);

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

  const onReact = useCallback(
    async (message: MessageRow, emoji: string) => {
      const isClearing = message.reaction_mine === emoji;
      const nextEmoji = isClearing ? null : emoji;
      setMyReaction(message.id, nextEmoji);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, reaction_mine: nextEmoji } : m)));

      if (isTestBot || !conversation || !email) return;
      try {
        if (isClearing) {
          getSocket().emit("reaction:clear", { messageId: message.id, recipientId: conversationId });
          return;
        }
        const identity = await getOrCreateIdentity(email);
        await sodium.ready;
        const peerPublicKey = sodium.from_base64(conversation.peer_public_key);
        const payload: ReactionPayload = { emoji };
        const { ciphertext, nonce } = await encryptMessage(
          JSON.stringify(payload),
          peerPublicKey,
          identity.privateKey
        );
        getSocket().emit("reaction:set", { messageId: message.id, recipientId: conversationId, ciphertext, nonce });
      } catch (err) {
        console.warn("[chat] failed to send reaction", err);
      }
    },
    [conversation, conversationId, isTestBot, email]
  );

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
        // FlatList's default initialNumToRender (10) only renders from the
        // start of `data`, which is oldest-first here — with a longer history
        // that leaves the true latest message unrendered, so scrollToEnd below
        // lands at the bottom of whatever's rendered so far, not the real end.
        initialNumToRender={listItems.length || 1}
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
              isGroupEnd={item.isGroupEnd}
              onReply={onReply}
              onCopy={onCopy}
              onDelete={onDelete}
              onRetry={onRetry}
              onPin={onPin}
              onUnpin={onUnpin}
              onDeleteForEveryone={onDeleteForEveryone}
              onOpenMenu={openMenu}
              onCancelSend={onCancelSend}
            />
          )
        }
      />

      <MessageActionMenu
        visible={!!menu}
        anchor={menu?.anchor ?? null}
        actions={menu?.actions ?? []}
        currentReaction={menu?.message.reaction_mine ?? null}
        onReact={menu ? (emoji) => onReact(menu.message, emoji) : undefined}
        onClose={() => setMenu(null)}
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
        {voiceRecorder.isRecording ? (
          <Animated.View
            style={[styles.recordingBar, { transform: [{ translateX: voiceRecorder.translateX }] }]}
          >
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTime} numberOfLines={1}>
              {formatRecordingTime(voiceRecorder.durationMs)}
            </Text>
            <View style={styles.slideHint}>
              <Ionicons name="chevron-back" size={14} color={colors.textTertiary} />
              <Text style={styles.slideHintText}>
                {voiceRecorder.cancelArmed ? "Release to cancel" : "Slide to cancel"}
              </Text>
            </View>
          </Animated.View>
        ) : (
          <>
            <Pressable style={styles.emojiButton} onPress={() => setEmojiPickerOpen(true)} hitSlop={8}>
              <Ionicons name="happy-outline" size={24} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.emojiButton} onPress={showImageSourceOptions} hitSlop={8}>
              <Ionicons name="camera-outline" size={24} color={colors.textSecondary} />
            </Pressable>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message"
              placeholderTextColor={colors.textTertiary}
              multiline
            />
          </>
        )}

        {draft.trim() ? (
          <Pressable style={styles.sendButton} onPress={onSend}>
            <Ionicons
              name="paper-plane"
              size={18}
              color="#fff"
              style={{ transform: [{ rotate: "45deg" }] }}
            />
          </Pressable>
        ) : (
          <View
            style={[styles.micButton, voiceRecorder.isRecording && styles.micButtonActive]}
            {...voiceRecorder.panHandlers}
          >
            <Ionicons name="mic" size={20} color={voiceRecorder.isRecording ? "#fff" : colors.textSecondary} />
          </View>
        )}
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

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    missing: { color: colors.textTertiary },
    headerTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    headerTitleRowPressed: { opacity: 0.6 },
    headerAvatarWrap: { position: "relative" },
    headerAvatar: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
    headerAvatarText: { fontSize: 14, fontWeight: "700", color: "#fff" },
    headerOnlineDot: {
      position: "absolute",
      bottom: -1,
      right: -1,
      width: 11,
      height: 11,
      borderRadius: 5.5,
      backgroundColor: colors.tickRead,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    headerTextCol: { flexShrink: 1, maxWidth: 175, justifyContent: "center" },
    headerName: { fontSize: 17, fontWeight: "700", color: colors.text },
    headerStatus: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
    headerStatusOnline: { fontSize: 12, fontWeight: "500", color: colors.tickRead, marginTop: 1 },
    list: { padding: 12 },
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
    bubbleRowSpaced: { marginBottom: 10 },
    bubbleRowTight: { marginBottom: 2 },
    bubbleRowReacted: { marginBottom: 18 },
    bubble: {
      maxWidth: "80%",
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 8,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 2,
      elevation: 1,
    },
    outgoing: { alignSelf: "flex-end", backgroundColor: colors.accent, borderBottomRightRadius: 6 },
    incoming: { alignSelf: "flex-start", backgroundColor: colors.bubbleIncoming, borderBottomLeftRadius: 6 },
    outgoingGrouped: { borderBottomRightRadius: 20 },
    incomingGrouped: { borderBottomLeftRadius: 20 },
    reactionBadge: {
      position: "absolute",
      bottom: -10,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
    },
    reactionBadgeOutgoing: { right: 6 },
    reactionBadgeIncoming: { left: 6 },
    reactionBadgeText: { fontSize: 13 },
    outgoingText: { color: "#fff", fontSize: 15.5 },
    incomingText: { color: colors.text, fontSize: 15.5 },
    deletedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    outgoingDeletedText: { color: "rgba(255,255,255,0.75)", fontSize: 15, fontStyle: "italic" },
    incomingDeletedText: { color: colors.textTertiary, fontSize: 15, fontStyle: "italic" },
    replyQuote: { paddingLeft: 6, marginBottom: 4 },
    replyQuoteOutgoing: { borderLeftWidth: 3, borderLeftColor: "rgba(255,255,255,0.6)" },
    replyQuoteIncoming: { borderLeftWidth: 3, borderLeftColor: colors.accent },
    replyQuoteTextOutgoing: { fontSize: 12, color: "rgba(255,255,255,0.85)", fontStyle: "italic" },
    replyQuoteTextIncoming: { fontSize: 12, color: colors.textSecondary, fontStyle: "italic" },
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
      color: colors.text,
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
    micButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    micButtonActive: { backgroundColor: colors.danger },
    recordingBar: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
    recordingTime: {
      fontSize: 14,
      color: colors.text,
      width: 46,
      fontVariant: ["tabular-nums"],
    },
    slideHint: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 },
    slideHintText: { fontSize: 13, color: colors.textTertiary },
  });
