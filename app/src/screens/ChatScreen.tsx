import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import sodium from "react-native-libsodium";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type EmojiType } from "rn-emoji-keyboard";

import type { MainStackParamList } from "../../App";
import { getUserById } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useVoiceRecorder, type RecordedVoice } from "../audio/useVoiceRecorder";
import { acceptContactRequest, rejectContactRequest } from "../chat/contactRequests";
import { persistRecordedVoice, readVoiceMessageBase64 } from "../audio/voiceStorage";
import AttachmentSheet from "../components/AttachmentSheet";
import Avatar from "../components/Avatar";
import FileMessageBubble from "../components/FileMessageBubble";
import EmojiGifTray from "../components/EmojiGifTray";
import ImageMessageBubble from "../components/ImageMessageBubble";
import MessageActionMenu, { type MessageAction, type MessageMenuAnchor } from "../components/MessageActionMenu";
import VideoMessageBubble from "../components/VideoMessageBubble";
import VoiceMessageBubble from "../components/VoiceMessageBubble";
import { encryptMessage, getOrCreateIdentity } from "../crypto/identity";
import {
  deleteMessage,
  getCallsForConversation,
  getConversationById,
  getMessages,
  getPeerDevices,
  getUnreadIncomingMessages,
  insertMessage,
  markMessageDelivered,
  markMessageDeletedEverywhere,
  markMessageFailed,
  markMessagePending,
  markMessageRead,
  markMessageSent,
  pinMessage,
  replacePeerDevices,
  setMessageMediaStatus,
  setMyReaction,
  unpinMessage,
  updateConversationPeerKey,
  updateConversationProfile,
  type CallRow,
  type MessageRow,
} from "../db/database";
import {
  ChatMediaTooLargeError,
  ChatMediaUploadUnavailableError,
  deletePendingChatMediaCiphertext,
  encryptFileForUpload,
  maxBytesForChatMediaKind,
  uploadChatMedia,
} from "../media/chatMediaUpload";
import { fetchAndStoreChatMedia } from "../media/chatMediaDownload";
import { compressImage } from "../media/imageCompression";
import { deleteImageMessage, persistPickedImage, readImageMessageBase64 } from "../media/imageStorage";
import { deleteFileMessage, persistPickedFile, readFileMessageBase64 } from "../media/fileStorage";
import { deleteVideoMessage, persistPickedVideo, readVideoMessageBase64 } from "../media/videoStorage";
import { type PickedGif } from "../media/gifPicker";
import {
  base64FromRemoteUrl,
  isDownloadAvailable,
  saveMediaToDevice,
  type MediaCategory,
} from "../media/downloadStorage";
import { useCall } from "../calls/CallContext";
import { getSocket } from "../network/socket";
import { useMessaging, type MessagePayload, type ReactionPayload } from "../messaging/MessagingContext";
import { setActiveConversationId } from "../notifications/activeChatTracker";
import { clearNotificationsForConversation } from "../notifications/notificationService";
import { usePresence } from "../presence/PresenceContext";
import { cleanupExpiredTestBotMessages, TEST_BOT_CONVERSATION_ID } from "../testBot";
import { generateTestBotReply } from "../testBotAi";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

const VOICE_MESSAGE_LABEL = "🎤 Voice message";
const IMAGE_MESSAGE_LABEL = "📷 Photo";
const GIF_MESSAGE_LABEL = "🎞️ GIF";
const VIDEO_MESSAGE_LABEL = "🎬 Video";

// Kinds sent through the S3 encrypt-then-upload pipeline (see
// media/chatMediaUpload.ts) — image via camera/attachment-menu, video, and
// generic file attachments. Voice notes and legacy inline images are not
// included; they keep sending as base64 embedded in the encrypted payload.
type AttachmentKind = "image" | "video" | "file";

// Spread into MessageRow literals for kinds that never touch video/file/S3
// media (text, voice, gif, legacy inline images) so those columns don't have
// to be repeated null-by-null at every construction site.
const NO_MEDIA_FIELDS = {
  video_uri: null,
  video_width: null,
  video_height: null,
  video_duration_ms: null,
  video_size: null,
  file_uri: null,
  file_name: null,
  file_mime: null,
  file_size: null,
  media_url: null,
  media_key: null,
  media_nonce: null,
  media_status: "ready",
} as const;

type Props = NativeStackScreenProps<MainStackParamList, "Chat">;

interface ReplyTarget {
  id: string;
  preview: string;
}

const REPLY_PREVIEW_MAX_LENGTH = 80;
const SEND_TIMEOUT_MS = 15000;
const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 60 * 60 * 1000;
// How long to wait after the last keystroke before telling the peer we
// stopped typing.
const TYPING_STOP_DELAY_MS = 2500;
// Safety net on the receiving side: clears a stuck "typing…" indicator if a
// typing:stop never arrives (peer's app crashed, lost network, etc).
const TYPING_RECEIVE_TIMEOUT_MS = 6000;
// Same safety net, for the peer-is-recording indicator.
const RECORDING_RECEIVE_TIMEOUT_MS = 6000;

// text.slice cuts by UTF-16 code unit, which can land inside a surrogate
// pair — most emoji outside the BMP (😀, 🎉, ...) are two code units — and
// corrupt the preview into a lone surrogate that renders as a broken glyph.
// Array.from splits by code point instead, so a cut always falls between
// whole characters (long ZWJ sequences like family/flag emoji can still be
// split into their constituent parts, but each part still renders validly).
function truncate(text: string) {
  const chars = Array.from(text);
  return chars.length > REPLY_PREVIEW_MAX_LENGTH
    ? `${chars.slice(0, REPLY_PREVIEW_MAX_LENGTH).join("")}…`
    : text;
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
  avatarUrl,
  online,
  lastSeenAt,
  onPress,
}: {
  name: string;
  avatarUrl: string | null;
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
      <Avatar name={name} avatarUrl={avatarUrl} size={36} onlineDot={online} />
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

function ChatHeaderCallButtons({ conversationId, disabled }: { conversationId: string; disabled: boolean }) {
  const { colors } = useTheme();
  const { startCall } = useCall();
  const iconColor = disabled ? colors.textTertiary : colors.accent;

  return (
    <View style={{ flexDirection: "row", gap: 18 }}>
      <Pressable onPress={() => startCall(conversationId, "audio")} disabled={disabled} hitSlop={8}>
        <Ionicons name="call-outline" size={22} color={iconColor} />
      </Pressable>
      <Pressable onPress={() => startCall(conversationId, "video")} disabled={disabled} hitSlop={8}>
        <Ionicons name="videocam-outline" size={24} color={iconColor} />
      </Pressable>
    </View>
  );
}

/** Replaces the message composer while a contact request is unresolved — see ConversationStatus. */
function RequestActionBanner({
  status,
  peerName,
  peerAvatarUrl,
  onAccept,
  onReject,
}: {
  status: "pending_outgoing" | "pending_incoming" | "declined";
  peerName: string;
  peerAvatarUrl: string | null;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (status === "pending_incoming") {
    return (
      <View style={styles.requestBanner}>
        <View style={styles.requestBannerPeerRow}>
          <Avatar name={peerName} avatarUrl={peerAvatarUrl} size={40} />
          <Text style={[styles.requestBannerText, styles.requestBannerPeerText]}>
            {peerName} wants to message you.
          </Text>
        </View>
        <View style={styles.requestBannerActions}>
          <Pressable style={[styles.requestBannerButton, styles.requestBannerReject]} onPress={onReject}>
            <Text style={[styles.requestBannerButtonText, { color: colors.danger }]}>Decline</Text>
          </Pressable>
          <Pressable style={[styles.requestBannerButton, styles.requestBannerAccept]} onPress={onAccept}>
            <Text style={[styles.requestBannerButtonText, { color: "#fff" }]}>Accept</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.requestBanner}>
      <Text style={styles.requestBannerText}>
        {status === "pending_outgoing" ? "Request sent — waiting for them to accept." : "This request was declined."}
      </Text>
    </View>
  );
}

type ListItem =
  | { type: "separator"; id: string; label: string }
  | { type: "message"; id: string; message: MessageRow; isGroupEnd: boolean }
  | { type: "call"; id: string; call: CallRow };

type ChatEntry =
  | { kind: "message"; ts: number; message: MessageRow }
  | { kind: "call"; ts: number; call: CallRow };

/**
 * Consecutive messages from the same side are visually grouped (tighter
 * spacing, tail corner only on the last one) — a day boundary, a call log
 * entry, or a change in direction always ends a group.
 */
function buildListItems(entries: ChatEntry[]): ListItem[] {
  const items: ListItem[] = [];
  let lastLabel: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const label = dayLabel(entry.ts);
    if (label !== lastLabel) {
      items.push({ type: "separator", id: `sep-${entry.kind}-${i}`, label });
      lastLabel = label;
    }
    if (entry.kind === "call") {
      items.push({ type: "call", id: entry.call.id, call: entry.call });
      continue;
    }
    const next = entries[i + 1];
    const isGroupEnd =
      !next ||
      next.kind !== "message" ||
      next.message.direction !== entry.message.direction ||
      dayLabel(next.ts) !== label;
    items.push({ type: "message", id: entry.message.id, message: entry.message, isGroupEnd });
  }
  return items;
}

function formatCallDuration(call: CallRow): string | null {
  if (call.status !== "completed" || !call.answered_at || !call.ended_at) return null;
  const totalSeconds = Math.max(0, Math.round((call.ended_at - call.answered_at) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function callStatusLabel(call: CallRow): string {
  if (call.status === "missed") return call.direction === "incoming" ? "Missed call" : "No answer";
  if (call.status === "declined") return "Declined";
  if (call.status === "failed") return "Call failed";
  return formatCallDuration(call) ?? "Call ended";
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
  onSaveMedia: (message: MessageRow) => void;
  onDownload: (message: MessageRow) => void;
  /** Fraction 0..1 of an in-flight attachment upload for this message, if any. */
  uploadProgress?: number;
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
  onSaveMedia,
  onDownload,
  uploadProgress,
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
        if (message.kind !== "text" && isDownloadAvailable()) {
          actions.push({
            label: "Save to device",
            icon: "download-outline",
            onPress: () => onSaveMedia(message),
          });
        }
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
                  uploadProgress={isOutgoing ? uploadProgress : undefined}
                  onCancelSend={
                    isOutgoing && message.status === "pending" ? () => onCancelSend(message) : undefined
                  }
                />
              ) : message.kind === "gif" ? (
                <View>
                  <ImageMessageBubble
                    imageUri={message.gif_url}
                    width={message.gif_width ?? 0}
                    height={message.gif_height ?? 0}
                    isSending={isOutgoing && message.status === "pending"}
                    onCancelSend={
                      isOutgoing && message.status === "pending" ? () => onCancelSend(message) : undefined
                    }
                  />
                  {/* GIPHY's terms require attribution wherever their content is
                      shown, not just in the picker — GiphyMediaView shows this
                      automatically, but a plain Image (used here for parity
                      with how photos render) doesn't. */}
                  <Text style={styles.gifAttribution}>GIPHY</Text>
                </View>
              ) : message.kind === "video" ? (
                <VideoMessageBubble
                  videoUri={message.video_uri}
                  width={message.video_width ?? 0}
                  height={message.video_height ?? 0}
                  durationMs={message.video_duration_ms ?? 0}
                  sizeBytes={message.file_size}
                  mediaStatus={message.media_status}
                  isSending={isOutgoing && message.status === "pending"}
                  uploadProgress={isOutgoing ? uploadProgress : undefined}
                  onDownload={!isOutgoing ? () => onDownload(message) : undefined}
                  onCancelSend={
                    isOutgoing && message.status === "pending" ? () => onCancelSend(message) : undefined
                  }
                />
              ) : message.kind === "file" ? (
                <FileMessageBubble
                  fileName={message.file_name ?? "File"}
                  mime={message.file_mime}
                  sizeBytes={message.file_size}
                  isLocal={!!message.file_uri}
                  mediaStatus={message.media_status}
                  isSending={isOutgoing && message.status === "pending"}
                  isOutgoing={isOutgoing}
                  uploadProgress={isOutgoing ? uploadProgress : undefined}
                  onDownload={!isOutgoing ? () => onDownload(message) : undefined}
                />
              ) : (
                <Text style={isOutgoing ? styles.outgoingText : styles.incomingText}>{message.plaintext}</Text>
              )}
            </>
          )}
          <Pressable
            style={styles.metaRow}
            onPress={() => onRetry(message)}
            disabled={message.status !== "failed" && message.media_status !== "download_failed"}
          >
            {isPinned ? (
              <Ionicons
                name="pin"
                size={11}
                color={isOutgoing ? "rgba(255,255,255,0.75)" : colors.textTertiary}
              />
            ) : null}
            <Text style={isOutgoing ? styles.metaTextOutgoing : styles.metaTextIncoming}>
              {message.status === "failed"
                ? "Not sent · tap to retry"
                : message.media_status === "download_failed"
                  ? "Couldn't load · tap to retry"
                  : formatTime(message.sent_at)}
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

function CallBubble({ call, onRedial }: { call: CallRow; onRedial: (call: CallRow) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isOutgoing = call.direction === "outgoing";
  const isMissedLike = call.status === "missed" || call.status === "declined" || call.status === "failed";

  return (
    <View style={[styles.bubbleRowSpaced, { alignSelf: isOutgoing ? "flex-end" : "flex-start" }]}>
      <Pressable
        style={[styles.callBubble, isOutgoing ? styles.outgoing : styles.incoming]}
        onPress={() => onRedial(call)}
      >
        <View style={[styles.callBubbleIcon, isOutgoing ? styles.callBubbleIconOutgoing : styles.callBubbleIconIncoming]}>
          <Ionicons
            name={call.kind === "video" ? "videocam" : "call"}
            size={16}
            color={isOutgoing ? "#fff" : colors.accent}
          />
        </View>
        <View style={styles.callBubbleText}>
          <View style={styles.callBubbleLabelRow}>
            <Ionicons
              name={isOutgoing ? "arrow-up-outline" : "arrow-down-outline"}
              size={12}
              color={
                isMissedLike
                  ? colors.danger
                  : isOutgoing
                    ? "rgba(255,255,255,0.8)"
                    : colors.textSecondary
              }
            />
            <Text style={[isOutgoing ? styles.outgoingText : styles.incomingText, styles.callBubbleLabel]}>
              {call.kind === "video" ? "Video call" : "Audio call"}
            </Text>
          </View>
          <Text
            style={[
              isOutgoing ? styles.metaTextOutgoing : styles.metaTextIncoming,
              isMissedLike && (isOutgoing ? styles.callMetaMissedOutgoing : styles.callMetaMissedIncoming),
            ]}
          >
            {callStatusLabel(call)} · {formatTime(call.started_at)}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

export default function ChatScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const { email, token } = useAuth();
  const [conversation, setConversation] = useState(() => getConversationById(conversationId));
  useEffect(() => {
    setConversation(getConversationById(conversationId));
  }, [conversationId]);
  const isTestBot = conversationId === TEST_BOT_CONVERSATION_ID;

  // Best-effort: refresh the peer's cached public key and profile (name,
  // avatar, contact number) when opening the chat. insertConversation only
  // ever writes these once, on first contact — if the peer reinstalled or
  // re-registered since (rotating their identity keypair), our cached key is
  // stale and every message we send from here would be encrypted for a key
  // they can no longer decrypt with, with no error on either end. Likewise a
  // profile edit on their end (new photo, new name) would otherwise never
  // reach this device's header/conversation list. See MessagingContext's
  // decrypt-retry for the receive-side of the key case.
  useEffect(() => {
    if (isTestBot || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const peer = await getUserById(token, conversationId);
        if (cancelled) return;
        const current = getConversationById(conversationId);
        const keyChanged = peer.publicKey !== current?.peer_public_key;
        const profileChanged =
          peer.name !== current?.display_name ||
          peer.avatarUrl !== current?.avatar_url ||
          peer.contactNumber !== current?.contact_number;
        if (keyChanged) updateConversationPeerKey(conversationId, peer.publicKey);
        if (profileChanged) updateConversationProfile(conversationId, peer.name, peer.avatarUrl, peer.contactNumber);
        if (keyChanged || profileChanged) setConversation(getConversationById(conversationId));
        // Wholesale replace, not merge — a device missing from this response
        // has been unlinked server-side and must stop being a valid send
        // target, not just linger as stale cache (see replacePeerDevices).
        replacePeerDevices(
          conversationId,
          peer.devices.map((d) => ({ device_id: d.deviceId, public_key: d.publicKey }))
        );
      } catch (err) {
        console.warn("[chat] failed to refresh peer key/profile", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-check on (re)opening this conversation, not every conversation-state change
  }, [conversationId, isTestBot, token]);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [messages, setMessages] = useState<MessageRow[]>(() => getMessages(conversationId));
  const [calls, setCalls] = useState<CallRow[]>(() => getCallsForConversation(conversationId));
  const [draft, setDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);
  const [attachmentAnchor, setAttachmentAnchor] = useState<MessageMenuAnchor | null>(null);
  const attachmentButtonRef = useRef<View>(null);
  // Single combined emoji/GIF tray (see EmojiGifTray) in place of the
  // keyboard — replaces what used to be two separate pieces of state for a
  // dedicated emoji picker and a dedicated GIF tray.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Sized to the last-measured real keyboard height so the tray occupies the
  // same footprint a keyboard would — falls back to a sane default before
  // the keyboard has ever been shown this session.
  const [keyboardHeight, setKeyboardHeight] = useState(320);
  const [menu, setMenu] = useState<{
    message: MessageRow;
    actions: MessageAction[];
    anchor: MessageMenuAnchor;
  } | null>(null);
  const listRef = useRef<FlatList<ListItem>>(null);
  const readSentRef = useRef<Set<string>>(new Set());

  // scrollToEnd below is normally driven by onContentSizeChange, but opening
  // the keyboard shrinks the visible viewport without changing content size
  // at all, so that handler never fires — the latest messages (and the
  // composer under them) can end up hidden behind the keyboard until the
  // user manually scrolls. Nudge the list back to the bottom whenever the
  // keyboard opens to cover that gap on both platforms.
  useEffect(() => {
    const event = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const sub = Keyboard.addListener(event, (e) => {
      listRef.current?.scrollToEnd({ animated: true });
      setKeyboardHeight(e.endCoordinates.height);
    });
    return () => sub.remove();
  }, []);
  const listItems = useMemo(() => {
    const entries: ChatEntry[] = [
      ...messages.map((message) => ({ kind: "message" as const, ts: message.sent_at, message })),
      ...calls.map((call) => ({ kind: "call" as const, ts: call.started_at, call })),
    ].sort((a, b) => a.ts - b.ts);
    return buildListItems(entries);
  }, [messages, calls]);
  const pinnedMessage = useMemo(() => messages.find((m) => m.pinned_at) ?? null, [messages]);

  const { startCall, phase: callPhase } = useCall();
  const onRedial = useCallback(
    (call: CallRow) => {
      if (!isTestBot) void startCall(conversationId, call.kind);
    },
    [conversationId, isTestBot, startCall]
  );

  // Calls are logged by CallContext outside of this screen's lifecycle (it
  // navigates to ActiveCall/IncomingCall while the call is in progress), so
  // re-read whenever a call just wrapped up (phase back to idle) in addition
  // to the normal focus-driven refresh below.
  useEffect(() => {
    if (callPhase === "idle") setCalls(getCallsForConversation(conversationId));
  }, [callPhase, conversationId]);

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

  // --- Typing indicator ---

  const [peerTyping, setPeerTyping] = useState(false);
  const typingStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingActiveRef = useRef(false);
  const peerTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tells the peer we stopped typing, if we'd previously told them we
  // started. Idempotent, so every "stop" call site (inactivity timeout,
  // message sent, input cleared, leaving the screen) can call it freely.
  const stopTypingNow = useCallback(() => {
    if (typingStopTimeoutRef.current) {
      clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = null;
    }
    if (isTypingActiveRef.current) {
      isTypingActiveRef.current = false;
      if (!isTestBot) getSocket().emit("typing:stop", { recipientId: conversationId });
    }
  }, [conversationId, isTestBot]);

  // Debounces our own typing:start/stop emits: fires "start" once per burst
  // of typing, then "stop" after TYPING_STOP_DELAY_MS of no further
  // keystrokes (reset on every call), rather than one event per keystroke.
  const handleDraftChange = useCallback(
    (text: string) => {
      setDraft(text);
      if (isTestBot) return;

      if (!text.trim()) {
        stopTypingNow();
        return;
      }

      if (!isTypingActiveRef.current) {
        isTypingActiveRef.current = true;
        getSocket().emit("typing:start", { recipientId: conversationId });
      }
      if (typingStopTimeoutRef.current) clearTimeout(typingStopTimeoutRef.current);
      typingStopTimeoutRef.current = setTimeout(stopTypingNow, TYPING_STOP_DELAY_MS);
    },
    [conversationId, isTestBot, stopTypingNow]
  );

  // Peer's typing:update pushes straight into local state — this is a
  // live UI signal only, never written to the message DB/history.
  useEffect(() => {
    if (isTestBot) return;
    const socket = getSocket();
    const onTypingUpdate = ({ userId, typing }: { userId: string; typing: boolean }) => {
      if (userId !== conversationId) return;
      if (peerTypingTimeoutRef.current) {
        clearTimeout(peerTypingTimeoutRef.current);
        peerTypingTimeoutRef.current = null;
      }
      setPeerTyping(typing);
      if (typing) {
        peerTypingTimeoutRef.current = setTimeout(() => setPeerTyping(false), TYPING_RECEIVE_TIMEOUT_MS);
      }
    };
    socket.on("typing:update", onTypingUpdate);
    return () => {
      socket.off("typing:update", onTypingUpdate);
      if (peerTypingTimeoutRef.current) clearTimeout(peerTypingTimeoutRef.current);
      setPeerTyping(false);
    };
  }, [conversationId, isTestBot]);

  const onAcceptRequest = useCallback(async () => {
    const ok = await acceptContactRequest(conversationId);
    if (!ok) {
      Alert.alert("Couldn't accept", "Please try again.");
      return;
    }
    setConversation(getConversationById(conversationId));
  }, [conversationId]);

  const onRejectRequest = useCallback(() => {
    Alert.alert("Decline this request?", `Choose what to do about ${conversation?.display_name ?? "this person"}.`, [
      { text: "Report", style: "destructive", onPress: () => void rejectContactRequest(conversationId, "report").then(() => navigation.goBack()) },
      { text: "Block", style: "destructive", onPress: () => void rejectContactRequest(conversationId, "block").then(() => navigation.goBack()) },
      { text: "No action", onPress: () => void rejectContactRequest(conversationId, "none").then(() => navigation.goBack()) },
    ]);
  }, [conversationId, conversation?.display_name, navigation]);

  useLayoutEffect(() => {
    const name = conversation?.display_name ?? "Chat";
    navigation.setOptions({
      title: name,
      // iOS defaults headerTitleAlign to "center", which centers our custom
      // (avatar + name) title in the whole space between headerLeft and
      // headerRight rather than placing it right after the back button —
      // that's what reads as a gap between them. Force it flush-left instead.
      headerTitleAlign: "left",
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
              avatarUrl={conversation?.avatar_url ?? null}
              online={peerPresence?.online ?? false}
              lastSeenAt={peerPresence?.lastSeenAt ?? null}
              onPress={() => navigation.navigate("ContactInfo", { conversationId })}
            />
          ),
      headerRight: isTestBot
        ? undefined
        : () => (
            <ChatHeaderCallButtons conversationId={conversationId} disabled={conversation?.status !== "accepted"} />
          ),
    });
  }, [
    navigation,
    conversation?.display_name,
    conversation?.avatar_url,
    conversation?.status,
    isTestBot,
    peerPresence,
    conversationId,
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
      if (isTestBot) cleanupExpiredTestBotMessages();
      setMessages(getMessages(conversationId));
      setCalls(getCallsForConversation(conversationId));
      markVisibleMessagesRead();
    }, [conversationId, isTestBot, markVisibleMessagesRead])
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
      return () => {
        setActiveConversationId(null);
        stopTypingNow();
      };
    }, [conversationId, stopTypingNow])
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

        // Real multi-device delivery: encrypt once per active recipient
        // device rather than once for a single (and, once the peer's second
        // device logs in, stale) cached key. Prefer the local cache
        // (refreshed on chat open, see the effect above); if it's empty —
        // e.g. this conversation was created but never opened yet — fetch
        // live rather than failing the send outright.
        let peerDevices = getPeerDevices(conversationId);
        if (peerDevices.length === 0 && token) {
          const peer = await getUserById(token, conversationId);
          peerDevices = peer.devices.map((d) => ({ device_id: d.deviceId, public_key: d.publicKey }));
          replacePeerDevices(conversationId, peerDevices);
        }
        if (peerDevices.length === 0) {
          throw new Error("recipient has no known devices to encrypt for");
        }

        const plaintext = JSON.stringify(payload);
        const envelopes = await Promise.all(
          peerDevices.map(async (device) => {
            const { ciphertext, nonce } = await encryptMessage(
              plaintext,
              sodium.from_base64(device.public_key),
              identity.privateKey
            );
            return { deviceId: device.device_id, ciphertext, nonce };
          })
        );

        getSocket()
          .timeout(SEND_TIMEOUT_MS)
          .emit(
            "message:send",
            { id, recipientId: conversationId, envelopes },
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
    [conversation, conversationId, email, token]
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

  const sendGifEncrypted = useCallback(
    (id: string, url: string, width: number, height: number, replyTo: ReplyTarget | null) =>
      sendPayload(id, { kind: "gif", url, width, height, replyTo: replyTo ?? undefined }),
    [sendPayload]
  );

  // Fraction 0..1 per in-flight attachment upload, keyed by message id — read
  // by the message bubbles to render a percentage over the sending spinner.
  const [uploadProgressById, setUploadProgressById] = useState<Record<string, number>>({});

  const clearUploadProgress = useCallback((id: string) => {
    setUploadProgressById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // Encrypts+uploads an already-persisted local attachment to S3, then sends
  // the S3 reference (+ the file's decryption key/nonce) through the normal
  // E2E-encrypted message channel — see crypto/fileCrypto.ts and
  // media/chatMediaUpload.ts for why this preserves the app's E2E guarantee.
  // Used both for a fresh send (via sendAttachment below) and for retrying an
  // upload that previously failed (see onRetry), from the same local file.
  const uploadThenSend = useCallback(
    async (
      id: string,
      plaintextUri: string,
      kind: AttachmentKind,
      meta: { width?: number; height?: number; durationMs?: number; name?: string; mime?: string },
      replyTo: ReplyTarget | null
    ) => {
      if (!token) return;
      try {
        const prepared = await encryptFileForUpload(plaintextUri, id, maxBytesForChatMediaKind(kind));
        const { publicUrl } = await uploadChatMedia(token, id, kind, prepared, (fraction) => {
          setUploadProgressById((prev) => ({ ...prev, [id]: fraction }));
        });
        clearUploadProgress(id);
        setMessageMediaStatus(id, "ready");

        if (kind === "image") {
          void sendPayload(id, {
            kind: "image",
            transport: "s3",
            url: publicUrl,
            keyB64: prepared.keyB64,
            nonceB64: prepared.nonceB64,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            size: prepared.plaintextSize,
            replyTo: replyTo ?? undefined,
          });
        } else if (kind === "video") {
          void sendPayload(id, {
            kind: "video",
            url: publicUrl,
            keyB64: prepared.keyB64,
            nonceB64: prepared.nonceB64,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            durationMs: meta.durationMs ?? 0,
            size: prepared.plaintextSize,
            replyTo: replyTo ?? undefined,
          });
        } else {
          void sendPayload(id, {
            kind: "file",
            url: publicUrl,
            keyB64: prepared.keyB64,
            nonceB64: prepared.nonceB64,
            name: meta.name ?? "file",
            mime: meta.mime ?? "application/octet-stream",
            size: prepared.plaintextSize,
            replyTo: replyTo ?? undefined,
          });
        }
      } catch (err) {
        clearUploadProgress(id);
        console.warn("[chat] failed to upload attachment", err);
        setMessageMediaStatus(id, "upload_failed");
        markMessageFailed(id);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, status: "failed", media_status: "upload_failed" } : m))
        );
        if (err instanceof ChatMediaTooLargeError) {
          Alert.alert("File too large", err.message);
        } else if (err instanceof ChatMediaUploadUnavailableError) {
          Alert.alert("Uploads unavailable", "Media uploads aren't available right now. Please try again later.");
        }
        // Any other failure (network blip, etc.) surfaces via the existing
        // "Not sent · tap to retry" affordance, same as a failed text send.
      }
    },
    [token, sendPayload, clearUploadProgress]
  );

  const onCancelSend = useCallback((message: MessageRow) => {
    cancelledSendIdsRef.current.add(message.id);
    deleteMessage(message.id);
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    clearUploadProgress(message.id);
    deletePendingChatMediaCiphertext(message.id);
    if (message.image_uri) deleteImageMessage(message.image_uri);
    if (message.video_uri) deleteVideoMessage(message.video_uri);
    if (message.file_uri) deleteFileMessage(message.file_uri);
  }, [clearUploadProgress]);

  // Shared by onRetry (a previously-failed download) and the video/file
  // bubbles' tap-to-download affordance (a fresh, never-attempted download —
  // video never auto-downloads, given files can be up to 100MB).
  const downloadMedia = useCallback(
    (message: MessageRow) => {
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, media_status: "downloading" } : m)));
      void fetchAndStoreChatMedia(message)
        .then(() => setMessages(getMessages(conversationId)))
        .catch(() => setMessages(getMessages(conversationId)));
    },
    [conversationId]
  );

  const onRetry = useCallback(
    (message: MessageRow) => {
      const replyTo = message.reply_to_id
        ? { id: message.reply_to_id, preview: message.reply_preview ?? "" }
        : null;

      // A failed attachment upload: re-run encrypt+upload from the same
      // local plaintext copy (already on disk from the original send), no
      // re-pick required.
      if (message.media_status === "upload_failed") {
        const localUri = message.image_uri ?? message.video_uri ?? message.file_uri;
        if (!localUri) return;
        markMessagePending(message.id);
        setMessageMediaStatus(message.id, "uploading");
        setMessages((prev) =>
          prev.map((m) => (m.id === message.id ? { ...m, status: "pending", media_status: "uploading" } : m))
        );
        void uploadThenSend(
          message.id,
          localUri,
          message.kind as AttachmentKind,
          {
            width: message.image_width ?? message.video_width ?? undefined,
            height: message.image_height ?? message.video_height ?? undefined,
            durationMs: message.video_duration_ms ?? undefined,
            name: message.file_name ?? undefined,
            mime: message.file_mime ?? undefined,
          },
          replyTo
        );
        return;
      }

      // A failed download of a peer's S3-backed attachment.
      if (message.media_status === "download_failed") {
        downloadMedia(message);
        return;
      }

      markMessagePending(message.id);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, status: "pending" } : m)));
      if (message.kind === "gif" && message.gif_url) {
        void sendGifEncrypted(message.id, message.gif_url, message.gif_width ?? 0, message.gif_height ?? 0, replyTo);
      } else if (message.kind === "voice" && message.audio_uri) {
        void sendVoiceEncrypted(
          message.id,
          message.audio_uri,
          message.duration_ms ?? 0,
          message.waveform ? JSON.parse(message.waveform) : [],
          replyTo
        );
      } else if (message.kind === "image" && message.image_uri && !message.media_url) {
        // Legacy inline-base64 image (pre-S3-attachment-pipeline, no
        // media_url) — re-embed the still-local plaintext directly in the
        // encrypted payload, same shape it was originally sent in.
        void sendPayload(message.id, {
          kind: "image",
          image: readImageMessageBase64(message.image_uri),
          width: message.image_width ?? 0,
          height: message.image_height ?? 0,
          replyTo: replyTo ?? undefined,
        });
      } else {
        void sendEncrypted(message.id, message.plaintext, replyTo);
      }
    },
    [sendEncrypted, sendVoiceEncrypted, sendGifEncrypted, sendPayload, uploadThenSend, downloadMedia]
  );

  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || !conversation) return;
    setDraft("");
    stopTypingNow();
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
      gif_url: null,
      gif_width: null,
      gif_height: null,
      ...NO_MEDIA_FIELDS,
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

        void (async () => {
          const replyText = await generateTestBotReply(text, getMessages(conversationId));

          const reply: MessageRow = {
            id: Crypto.randomUUID(),
            conversation_id: conversationId,
            direction: "incoming",
            plaintext: replyText,
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
            gif_url: null,
            gif_width: null,
            gif_height: null,
            ...NO_MEDIA_FIELDS,
          };
          insertMessage(reply);
          cleanupExpiredTestBotMessages();
          setMessages(getMessages(conversationId));
        })();
      }, 700);
      return;
    }

    void sendEncrypted(id, text, activeReply);
  }, [draft, conversation, conversationId, isTestBot, replyingTo, sendEncrypted, stopTypingNow]);

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
        gif_url: null,
        gif_width: null,
        gif_height: null,
        ...NO_MEDIA_FIELDS,
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

  // --- Recording indicator (peer is recording a voice note) ---
  // Mirrors the typing indicator above: pure ephemeral relay, no debounce
  // needed since voiceRecorder.isRecording is already a clean boolean.

  const [peerRecording, setPeerRecording] = useState(false);
  const isRecordingActiveRef = useRef(false);
  const peerRecordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopRecordingNow = useCallback(() => {
    if (isRecordingActiveRef.current) {
      isRecordingActiveRef.current = false;
      if (!isTestBot) getSocket().emit("recording:stop", { recipientId: conversationId });
    }
  }, [conversationId, isTestBot]);

  useEffect(() => {
    if (isTestBot) return;
    if (voiceRecorder.isRecording) {
      if (!isRecordingActiveRef.current) {
        isRecordingActiveRef.current = true;
        getSocket().emit("recording:start", { recipientId: conversationId });
      }
    } else {
      stopRecordingNow();
    }
  }, [voiceRecorder.isRecording, conversationId, isTestBot, stopRecordingNow]);

  // Stop telling the peer we're recording if this chat loses focus mid-recording.
  useFocusEffect(
    useCallback(() => {
      return () => stopRecordingNow();
    }, [stopRecordingNow])
  );

  // Peer's recording:update pushes straight into local state, same pattern
  // as typing:update above.
  useEffect(() => {
    if (isTestBot) return;
    const socket = getSocket();
    const onRecordingUpdate = ({ userId, recording }: { userId: string; recording: boolean }) => {
      if (userId !== conversationId) return;
      if (peerRecordingTimeoutRef.current) {
        clearTimeout(peerRecordingTimeoutRef.current);
        peerRecordingTimeoutRef.current = null;
      }
      setPeerRecording(recording);
      if (recording) {
        peerRecordingTimeoutRef.current = setTimeout(() => setPeerRecording(false), RECORDING_RECEIVE_TIMEOUT_MS);
      }
    };
    socket.on("recording:update", onRecordingUpdate);
    return () => {
      socket.off("recording:update", onRecordingUpdate);
      if (peerRecordingTimeoutRef.current) clearTimeout(peerRecordingTimeoutRef.current);
      setPeerRecording(false);
    };
  }, [conversationId, isTestBot]);

  // Persists the picked/captured source locally (compressing images first,
  // same as before), inserts an optimistic 'uploading' row for immediate
  // preview, then hands off to uploadThenSend. Shared by the camera button
  // and the attachment menu's Images/Video/Audio options.
  const sendAttachment = useCallback(
    async (
      sourceUri: string,
      kind: AttachmentKind,
      meta: { width?: number; height?: number; durationMs?: number; name?: string; mime?: string }
    ) => {
      if (!conversation) return;
      const activeReply = replyingTo;
      setReplyingTo(null);

      const id = Crypto.randomUUID();
      try {
        let plaintextUri: string;
        let width = meta.width ?? 0;
        let height = meta.height ?? 0;

        if (kind === "image") {
          const compressed = await compressImage(sourceUri, width, height);
          plaintextUri = await persistPickedImage(compressed.uri, id);
          width = compressed.width;
          height = compressed.height;
        } else if (kind === "video") {
          plaintextUri = await persistPickedVideo(sourceUri, id);
        } else {
          plaintextUri = await persistPickedFile(sourceUri, id, meta.name ?? "file");
        }

        const outgoing: MessageRow = {
          id,
          conversation_id: conversationId,
          direction: "outgoing",
          plaintext:
            kind === "image" ? IMAGE_MESSAGE_LABEL : kind === "video" ? VIDEO_MESSAGE_LABEL : `📎 ${meta.name ?? "file"}`,
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
          kind,
          audio_uri: null,
          duration_ms: null,
          waveform: null,
          image_uri: kind === "image" ? plaintextUri : null,
          image_width: kind === "image" ? width : null,
          image_height: kind === "image" ? height : null,
          gif_url: null,
          gif_width: null,
          gif_height: null,
          video_uri: kind === "video" ? plaintextUri : null,
          video_width: kind === "video" ? width : null,
          video_height: kind === "video" ? height : null,
          video_duration_ms: kind === "video" ? (meta.durationMs ?? null) : null,
          // Sender already has the local plaintext copy (video_uri, above),
          // so the tap-to-download size hint doesn't apply to their own
          // bubble — this is only ever populated on the receive side.
          video_size: null,
          file_uri: kind === "file" ? plaintextUri : null,
          file_name: kind === "file" ? (meta.name ?? null) : null,
          file_mime: kind === "file" ? (meta.mime ?? null) : null,
          file_size: null,
          media_url: null,
          media_key: null,
          media_nonce: null,
          media_status: "uploading",
        };
        insertMessage(outgoing);
        setMessages((prev) => [...prev, outgoing]);

        if (isTestBot) {
          markMessageSent(id);
          setMessageMediaStatus(id, "ready");
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent", media_status: "ready" } : m)));
          return;
        }

        void uploadThenSend(
          id,
          plaintextUri,
          kind,
          { width, height, durationMs: meta.durationMs, name: meta.name, mime: meta.mime },
          activeReply
        );
      } catch (err) {
        console.warn("[chat] failed to prepare attachment for sending", err);
        const title = kind === "image" ? "Couldn't send photo" : kind === "video" ? "Couldn't send video" : "Couldn't send file";
        Alert.alert(title, "Please try again.");
      }
    },
    [conversation, conversationId, isTestBot, replyingTo, uploadThenSend]
  );

  // The camera button now only ever launches the device camera (no gallery
  // chooser) — picking from the gallery lives in the "+" attachment menu.
  const pickImageFromCamera = useCallback(async () => {
    if (!conversation) return;
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Camera access needed", "Enable access in Settings to share photos.");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    await sendAttachment(asset.uri, "image", { width: asset.width, height: asset.height });
  }, [conversation, sendAttachment]);

  // "+" attachment menu: Images/Video pick from the gallery via
  // expo-image-picker (already a dependency, and already supports video
  // selection via mediaTypes); Audio picks an arbitrary file via
  // expo-document-picker, since expo-image-picker can't select audio files.
  const pickAndSendAttachment = useCallback(
    async (kind: "image" | "video" | "file") => {
      if (!conversation) return;

      if (kind === "file") {
        const result = await DocumentPicker.getDocumentAsync({ type: "audio/*" });
        if (result.canceled || !result.assets[0]) return;
        const asset = result.assets[0];
        await sendAttachment(asset.uri, "file", {
          name: asset.name,
          mime: asset.mimeType ?? "application/octet-stream",
        });
        return;
      }

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Photo access needed", "Enable access in Settings to share media.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: kind === "image" ? ["images"] : ["videos"],
        quality: 0.9,
      });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      if (kind === "image") {
        await sendAttachment(asset.uri, "image", { width: asset.width, height: asset.height });
      } else {
        await sendAttachment(asset.uri, "video", {
          width: asset.width,
          height: asset.height,
          durationMs: asset.duration ?? undefined,
        });
      }
    },
    [conversation, sendAttachment]
  );

  // Unlike sendAttachment, there's no compression/local-persistence/upload
  // step — the GIF already lives permanently on GIPHY's CDN, so the picked
  // url is the final payload as soon as it's picked.
  const sendGif = useCallback(
    (url: string, width: number, height: number) => {
      if (!conversation) return;
      const activeReply = replyingTo;
      setReplyingTo(null);

      const id = Crypto.randomUUID();
      const outgoing: MessageRow = {
        id,
        conversation_id: conversationId,
        direction: "outgoing",
        plaintext: GIF_MESSAGE_LABEL,
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
        kind: "gif",
        audio_uri: null,
        duration_ms: null,
        waveform: null,
        image_uri: null,
        image_width: null,
        image_height: null,
        gif_url: url,
        gif_width: width,
        gif_height: height,
        ...NO_MEDIA_FIELDS,
      };
      insertMessage(outgoing);
      setMessages((prev) => [...prev, outgoing]);

      if (isTestBot) {
        markMessageSent(id);
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)));
        return;
      }

      void sendGifEncrypted(id, url, width, height, activeReply);
    },
    [conversation, conversationId, isTestBot, replyingTo, sendGifEncrypted]
  );

  // Toggles the combined emoji/GIF tray in place of the keyboard (see
  // EmojiGifTray) rather than opening a full-screen native dialog. Always
  // opens back onto the emoji tab; the tray itself owns which tab is active.
  const togglePicker = useCallback(() => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    Keyboard.dismiss();
    setPickerOpen(true);
  }, [pickerOpen]);

  const handleEmojiSelected = useCallback(
    (emoji: EmojiType) => {
      handleDraftChange(draft + emoji.emoji);
    },
    [draft, handleDraftChange]
  );

  const handleGifSelected = useCallback(
    (gif: PickedGif) => {
      sendGif(gif.url, gif.width, gif.height);
      setPickerOpen(false);
    },
    [sendGif]
  );

  const onCopy = useCallback((message: MessageRow) => {
    Clipboard.setStringAsync(message.plaintext);
  }, []);

  const onSaveMedia = useCallback(async (message: MessageRow) => {
    let category: MediaCategory;
    let mimeType: string;
    let base64: string;
    try {
      if (message.kind === "image" && message.image_uri) {
        category = "Photos";
        mimeType = "image/jpeg";
        base64 = readImageMessageBase64(message.image_uri);
      } else if (message.kind === "voice" && message.audio_uri) {
        category = "Audio";
        mimeType = "audio/m4a";
        base64 = readVoiceMessageBase64(message.audio_uri);
      } else if (message.kind === "gif" && message.gif_url) {
        category = "Photos";
        mimeType = "image/gif";
        base64 = await base64FromRemoteUrl(message.gif_url);
      } else if (message.kind === "video" && message.video_uri) {
        category = "Video";
        mimeType = "video/mp4";
        base64 = readVideoMessageBase64(message.video_uri);
      } else if (message.kind === "file" && message.file_uri) {
        category = "Documents";
        mimeType = message.file_mime ?? "application/octet-stream";
        base64 = readFileMessageBase64(message.file_uri);
      } else {
        return;
      }

      const result = await saveMediaToDevice({ category, fileName: message.id, mimeType, base64 });
      if (result.ok) {
        Alert.alert("Saved", `Saved to Beacon/${category}.`);
      } else if (result.error === "permission_denied") {
        Alert.alert("Permission needed", "Grant folder access so Beacon can save media to your device.");
      } else {
        Alert.alert("Couldn't save", "Please try again.");
      }
    } catch (err) {
      console.warn("[chat] failed to save media", err);
      Alert.alert("Couldn't save", "Please try again.");
    }
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

        // Same per-device fan-out as sendPayload above: encrypt once per
        // active recipient device rather than once for a single (and,
        // once a second device logs in, stale) cached key.
        let peerDevices = getPeerDevices(conversationId);
        if (peerDevices.length === 0 && token) {
          const peer = await getUserById(token, conversationId);
          peerDevices = peer.devices.map((d) => ({ device_id: d.deviceId, public_key: d.publicKey }));
          replacePeerDevices(conversationId, peerDevices);
        }
        if (peerDevices.length === 0) return;

        const payload: ReactionPayload = { emoji };
        const plaintext = JSON.stringify(payload);
        const envelopes = await Promise.all(
          peerDevices.map(async (device) => {
            const { ciphertext, nonce } = await encryptMessage(
              plaintext,
              sodium.from_base64(device.public_key),
              identity.privateKey
            );
            return { deviceId: device.device_id, ciphertext, nonce };
          })
        );
        getSocket().emit("reaction:set", { messageId: message.id, recipientId: conversationId, envelopes });
      } catch (err) {
        console.warn("[chat] failed to send reaction", err);
      }
    },
    [conversation, conversationId, isTestBot, email, token]
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
      // "padding" on Android too: with edge-to-edge display (default since
      // Expo SDK 54 / RN 0.86), the OS's adjustResize window-resize this used
      // to lean on for Android no longer reliably shrinks the layout when the
      // keyboard opens, which left the input row covered. Explicitly padding
      // for the keyboard height works on both platforms regardless of that.
      behavior="padding"
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
          ) : item.type === "call" ? (
            <CallBubble call={item.call} onRedial={onRedial} />
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
              onSaveMedia={onSaveMedia}
              onDownload={downloadMedia}
              uploadProgress={uploadProgressById[item.message.id]}
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

      {peerRecording || peerTyping ? (
        <View style={styles.peerStatusBar}>
          <Text style={styles.peerStatusText} numberOfLines={1}>
            {(conversation?.display_name ?? "Contact") + (peerRecording ? " is recording audio…" : " is typing…")}
          </Text>
        </View>
      ) : null}

      {conversation && conversation.status !== "accepted" ? (
        <RequestActionBanner
          status={conversation.status}
          peerName={conversation.display_name ?? "This contact"}
          peerAvatarUrl={conversation.avatar_url}
          onAccept={onAcceptRequest}
          onReject={onRejectRequest}
        />
      ) : (
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
            <Pressable
              ref={attachmentButtonRef}
              style={styles.emojiButton}
              onPress={() => {
                // Measured fresh on every tap (rather than once on mount) so
                // the card lands directly above the button regardless of
                // whether the keyboard is currently open or closed — either
                // state can shift where this button actually sits on screen.
                attachmentButtonRef.current?.measureInWindow((x, y, width, height) => {
                  setAttachmentAnchor({ x, y, width, height });
                  setAttachmentSheetOpen(true);
                });
              }}
              hitSlop={8}
            >
              <Ionicons name="add-outline" size={24} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.emojiButton} onPress={() => void pickImageFromCamera()} hitSlop={8}>
              <Ionicons name="camera-outline" size={22} color={colors.textSecondary} />
            </Pressable>
            <View style={styles.inputWrapper}>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={handleDraftChange}
                placeholder="Message"
                placeholderTextColor={colors.textTertiary}
                multiline
              />
              {/* Opens the combined emoji/GIF tray (see EmojiGifTray) — hidden
                  once there's typed text so it doesn't sit on top of it, but
                  kept visible while the tray itself is open so there's always
                  a way to tap back to the keyboard. */}
              {pickerOpen || !draft.trim() ? (
                <Pressable style={styles.pickerBadge} onPress={togglePicker} hitSlop={8}>
                  {pickerOpen ? (
                    <MaterialCommunityIcons name="keyboard-outline" size={20} color={colors.textSecondary} />
                  ) : (
                    <Ionicons name="happy-outline" size={20} color={colors.textSecondary} />
                  )}
                </Pressable>
              ) : null}
            </View>
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
      )}

      {pickerOpen ? (
        <EmojiGifTray
          height={keyboardHeight}
          onEmojiSelected={handleEmojiSelected}
          onSelectGif={handleGifSelected}
        />
      ) : null}

      <AttachmentSheet
        visible={attachmentSheetOpen}
        anchor={attachmentAnchor}
        onClose={() => setAttachmentSheetOpen(false)}
        onPickImages={() => void pickAndSendAttachment("image")}
        onPickVideo={() => void pickAndSendAttachment("video")}
        onPickAudio={() => void pickAndSendAttachment("file")}
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
    headerTextCol: { flexShrink: 1, maxWidth: 175, justifyContent: "center" },
    // 70% of the previous 17px size, per request.
    headerName: { fontSize: 14.9, fontWeight: "700", color: colors.text },
    headerStatus: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
    headerStatusOnline: { fontSize: 11, fontWeight: "500", color: colors.tickRead, marginTop: 1 },
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
    callBubble: {
      maxWidth: "80%",
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 10,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 2,
      elevation: 1,
    },
    callBubbleIcon: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
    },
    callBubbleIconOutgoing: { backgroundColor: "rgba(255,255,255,0.2)" },
    callBubbleIconIncoming: { backgroundColor: colors.accentSoft },
    callBubbleText: { gap: 2 },
    callBubbleLabelRow: { flexDirection: "row", alignItems: "center", gap: 5 },
    callBubbleLabel: { fontSize: 15 },
    callMetaMissedOutgoing: { color: "rgba(255,214,214,0.95)" },
    callMetaMissedIncoming: { color: colors.danger },
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
    gifAttribution: {
      position: "absolute",
      bottom: 4,
      right: 8,
      fontSize: 9,
      fontWeight: "800",
      letterSpacing: 0.5,
      color: "rgba(255,255,255,0.85)",
      textShadowColor: "rgba(0,0,0,0.5)",
      textShadowRadius: 2,
      textShadowOffset: { width: 0, height: 0 },
    },
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
    peerStatusBar: {
      paddingHorizontal: 16,
      paddingTop: 4,
      paddingBottom: 2,
      backgroundColor: colors.background,
    },
    peerStatusText: { fontSize: 12, fontStyle: "italic", color: colors.textSecondary },
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
      gap: 2,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    requestBanner: {
      padding: 14,
      gap: 10,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    requestBannerText: { fontSize: 14, color: colors.textSecondary, textAlign: "center" },
    requestBannerPeerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    requestBannerPeerText: { flex: 1, textAlign: "left" },
    requestBannerActions: { flexDirection: "row", gap: 10 },
    requestBannerButton: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    requestBannerAccept: { backgroundColor: colors.accent },
    requestBannerReject: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
    requestBannerButtonText: { fontSize: 15, fontWeight: "600" },
    emojiButton: {
      width: 34,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    inputWrapper: {
      flex: 1,
      justifyContent: "center",
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      color: colors.text,
      borderRadius: 20,
      paddingLeft: 14,
      // Extra room on the right so typed text never runs under the picker trigger.
      paddingRight: 40,
      paddingVertical: 10,
      fontSize: 15.5,
      minHeight: 40,
      maxHeight: 100,
    },
    pickerBadge: {
      position: "absolute",
      right: 8,
      bottom: 9,
      width: 22,
      height: 22,
      alignItems: "center",
      justifyContent: "center",
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
