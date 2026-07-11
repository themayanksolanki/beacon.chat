import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import sodium from "react-native-libsodium";

import { getUserById } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { writeVoiceMessageBase64 } from "../audio/voiceStorage";
import { decryptMessage, getOrCreateIdentity } from "../crypto/identity";
import {
  getConversationById,
  insertConversation,
  insertMessage,
  isUserBlocked,
  markMessageDeletedEverywhere,
  markMessageDelivered,
  markMessageRead,
  setConversationStatus,
  setPeerReaction,
  updateConversationPeerKey,
  updateConversationProfile,
  type ConversationRow,
  type MessageRow,
} from "../db/database";
import { fetchAndStoreChatMedia } from "../media/chatMediaDownload";
import { writeImageMessageBase64 } from "../media/imageStorage";
import { getSocket } from "../network/socket";
import { navigateToConversation } from "../navigation/navigationRef";
import {
  addNotificationTapListener,
  clearNotificationsForConversation,
  configureNotificationHandler,
  consumeLastNotificationResponse,
  notifyNewMessage,
  requestNotificationPermissionsAsync,
} from "../notifications/notificationService";

const VOICE_MESSAGE_LABEL = "🎤 Voice message";
const IMAGE_MESSAGE_LABEL = "📷 Photo";
const GIF_MESSAGE_LABEL = "🎞️ GIF";
const VIDEO_MESSAGE_LABEL = "🎬 Video";

interface ReplyRef {
  id: string;
  preview: string;
}

// image has two wire shapes, disambiguated by `transport`: legacy inline
// (base64 embedded directly, same as voice) for messages sent before the S3
// attachment pipeline existed, vs. the new S3-backed shape (also used by
// video/file, always S3 — too big to ever go inline). `transport?: undefined`
// on the legacy variant lets payload.transport be checked directly to
// distinguish the two without a separate type guard.
export type MessagePayload =
  | { kind: "text"; text: string; replyTo?: ReplyRef }
  | { kind: "voice"; audio: string; durationMs: number; waveform: number[]; replyTo?: ReplyRef }
  | { kind: "image"; transport?: undefined; image: string; width: number; height: number; replyTo?: ReplyRef }
  | {
      kind: "image";
      transport: "s3";
      url: string;
      keyB64: string;
      nonceB64: string;
      width: number;
      height: number;
      size: number;
      replyTo?: ReplyRef;
    }
  | { kind: "gif"; url: string; width: number; height: number; replyTo?: ReplyRef }
  | {
      kind: "video";
      url: string;
      keyB64: string;
      nonceB64: string;
      width: number;
      height: number;
      durationMs: number;
      size: number;
      replyTo?: ReplyRef;
    }
  | {
      kind: "file";
      url: string;
      keyB64: string;
      nonceB64: string;
      name: string;
      mime: string;
      size: number;
      replyTo?: ReplyRef;
    };

export interface ReactionPayload {
  emoji: string;
}

interface IncomingServerMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
  created_at: number;
  // The specific device key this copy was actually encrypted with — real
  // multi-device means a peer's messages can arrive from different devices
  // with different keys, so trust this over the single cached
  // conversation.peer_public_key (which only reflects whichever device
  // logged in most recently). Falls back to the old cached-key+retry path
  // (see decryptFromPeer) if a server hasn't started sending this yet.
  sender_public_key: string | null;
}

interface IncomingServerReaction {
  message_id: string;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
  // Same reasoning as IncomingServerMessage.sender_public_key above.
  sender_public_key: string | null;
}

interface MessagingContextValue {
  /** Bumps whenever a message/receipt/reaction was written to the local DB, so mounted screens know to re-read it. */
  revision: number;
}

const MessagingContext = createContext<MessagingContextValue>({ revision: 0 });

/**
 * Owns the socket listeners for anything that mutates local chat state
 * (new messages, delivery/read receipts, deletions, reactions). Mounted once
 * at the app root so messages for a conversation are decrypted, persisted,
 * and acked regardless of which screen — if any — is currently open.
 */
export function MessagingProvider({ children }: { children: ReactNode }) {
  const { token, email } = useAuth();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!token) return;

    configureNotificationHandler();
    void requestNotificationPermissionsAsync();

    const handleTap = ({ conversationId }: { conversationId: string }) => {
      navigateToConversation(conversationId);
      void clearNotificationsForConversation(conversationId);
    };

    // Catches the notification that launched the app (cold start); warm/
    // background taps are caught by the listener below instead.
    const coldStartPayload = consumeLastNotificationResponse();
    if (coldStartPayload) handleTap(coldStartPayload);

    const subscription = addNotificationTapListener(handleTap);
    return () => subscription.remove();
  }, [token]);

  useEffect(() => {
    if (!token || !email) return;
    const socket = getSocket();
    const bump = () => setRevision((r) => r + 1);

    // Messages/reactions only ever carry the sender's id. If we don't have a
    // local conversation for them yet (they added us before we added them
    // back), resolve their identity from the server and create one on the
    // fly instead of dropping the message — see the "silent until I add them
    // back" bug this fixes.
    const ensureConversation = async (peerId: string): Promise<ConversationRow | null> => {
      const existing = getConversationById(peerId);
      if (existing) return existing;
      try {
        const peer = await getUserById(token, peerId);
        // A message/reaction can only arrive here at all if the server's
        // message:send/reaction:set gate already confirmed an accepted
        // contact relationship — this path now only fires for local-data-
        // loss cases (e.g. reinstall), never a genuine stranger.
        const conversation: ConversationRow = {
          id: peer.userId,
          peer_public_key: peer.publicKey,
          display_name: peer.name,
          avatar_url: peer.avatarUrl,
          created_at: Date.now(),
          status: "accepted",
          contact_number: peer.contactNumber,
        };
        insertConversation(conversation);
        return getConversationById(peerId);
      } catch (err) {
        console.warn("[messaging] failed to resolve unknown sender", err);
        return null;
      }
    };

    // Decrypts a payload from `senderId` using our cached copy of their public
    // key. If that fails, the cached key is most likely stale (they
    // reinstalled or re-registered, rotating their identity keypair) rather
    // than the payload being corrupt — refetch their current key from the
    // server, persist it, and retry once before giving up. Without this, a
    // stale cached key means messages/reactions from that sender are silently
    // dropped forever (caught, logged, never surfaced) until they're
    // re-added as a contact.
    const decryptFromPeer = async (
      senderId: string,
      cachedPeerPublicKeyB64: string,
      ciphertext: string,
      nonce: string,
      recipientPrivateKey: Uint8Array
    ): Promise<string> => {
      try {
        return await decryptMessage(ciphertext, nonce, sodium.from_base64(cachedPeerPublicKeyB64), recipientPrivateKey);
      } catch (err) {
        const peer = await getUserById(token, senderId);
        if (peer.publicKey === cachedPeerPublicKeyB64) throw err;
        updateConversationPeerKey(senderId, peer.publicKey);
        return decryptMessage(ciphertext, nonce, sodium.from_base64(peer.publicKey), recipientPrivateKey);
      }
    };

    const onMessage = async (message: IncomingServerMessage) => {
      if (isUserBlocked(message.sender_id)) return;
      const conversation = await ensureConversation(message.sender_id);
      if (!conversation) return;

      try {
        const identity = await getOrCreateIdentity(email);
        await sodium.ready;
        const decrypted = message.sender_public_key
          ? await decryptMessage(
              message.ciphertext,
              message.nonce,
              sodium.from_base64(message.sender_public_key),
              identity.privateKey
            )
          : await decryptFromPeer(
              message.sender_id,
              conversation.peer_public_key,
              message.ciphertext,
              message.nonce,
              identity.privateKey
            );
        const payload: MessagePayload = JSON.parse(decrypted);

        // Legacy inline images (pre-S3-attachment-pipeline) still arrive as
        // base64 embedded directly in the payload, same as voice.
        const isLegacyInlineImage = payload.kind === "image" && payload.transport !== "s3";
        const audioUri = payload.kind === "voice" ? writeVoiceMessageBase64(payload.audio, message.id) : null;
        const imageUri =
          payload.kind === "image" && isLegacyInlineImage ? writeImageMessageBase64(payload.image, message.id) : null;

        // S3-backed kinds (image sent via the new attachment pipeline, video,
        // file) don't carry their bytes in this payload at all — just the S3
        // reference and the symmetric key/nonce to decrypt it (see
        // crypto/fileCrypto.ts). Video defaults to 'idle' (tap-to-download,
        // given files can be up to 100MB) while image/file auto-download
        // below, same as legacy inline images did automatically.
        const isS3Media =
          payload.kind === "video" || payload.kind === "file" || (payload.kind === "image" && payload.transport === "s3");

        const row: MessageRow = {
          id: message.id,
          conversation_id: message.sender_id,
          direction: "incoming",
          plaintext:
            payload.kind === "voice"
              ? VOICE_MESSAGE_LABEL
              : payload.kind === "image"
                ? IMAGE_MESSAGE_LABEL
                : payload.kind === "gif"
                  ? GIF_MESSAGE_LABEL
                  : payload.kind === "video"
                    ? VIDEO_MESSAGE_LABEL
                    : payload.kind === "file"
                      ? `📎 ${payload.name}`
                      : payload.text,
          sent_at: message.created_at,
          status: "delivered",
          delivered_at: message.created_at,
          read_at: null,
          reply_to_id: payload.replyTo?.id ?? null,
          reply_preview: payload.replyTo?.preview ?? null,
          pinned_at: null,
          deleted_at: null,
          reaction_mine: null,
          reaction_peer: null,
          kind: payload.kind,
          audio_uri: audioUri,
          duration_ms: payload.kind === "voice" ? payload.durationMs : null,
          waveform: payload.kind === "voice" ? JSON.stringify(payload.waveform) : null,
          image_uri: imageUri,
          image_width: payload.kind === "image" ? payload.width : null,
          image_height: payload.kind === "image" ? payload.height : null,
          // GIFs are referenced by their GIPHY CDN url, not downloaded to a
          // local file — nothing analogous to writeImageMessageBase64 needed.
          gif_url: payload.kind === "gif" ? payload.url : null,
          gif_width: payload.kind === "gif" ? payload.width : null,
          gif_height: payload.kind === "gif" ? payload.height : null,
          video_uri: null,
          video_width: payload.kind === "video" ? payload.width : null,
          video_height: payload.kind === "video" ? payload.height : null,
          video_duration_ms: payload.kind === "video" ? payload.durationMs : null,
          video_size: payload.kind === "video" ? payload.size : null,
          file_uri: null,
          file_name: payload.kind === "file" ? payload.name : null,
          file_mime: payload.kind === "file" ? payload.mime : null,
          file_size: payload.kind === "file" ? payload.size : null,
          media_url: isS3Media ? payload.url : null,
          media_key: isS3Media ? payload.keyB64 : null,
          media_nonce: isS3Media ? payload.nonceB64 : null,
          media_status: payload.kind === "video" ? "idle" : isS3Media ? "downloading" : "ready",
        };
        insertMessage(row);
        getSocket().emit("message:delivered", { id: message.id });
        bump();

        // Fire-and-forget: image/file auto-download+decrypt in the
        // background (parity with legacy inline images' automatic local
        // write above); video stays 'idle' until the user taps to download
        // (see ChatScreen), given it can be far larger. Either way, bump()
        // again once the local file lands so mounted screens re-read it.
        if ((payload.kind === "image" && payload.transport === "s3") || payload.kind === "file") {
          void fetchAndStoreChatMedia(row)
            .then(bump)
            .catch(() => bump());
        }

        void notifyNewMessage({
          conversationId: message.sender_id,
          senderId: message.sender_id,
          senderName: conversation.display_name ?? "Unknown",
          messageId: message.id,
          messagePreview: row.plaintext,
          timestamp: message.created_at,
        });
      } catch (err) {
        console.warn("[messaging] failed to process incoming message", err);
      }
    };

    const onDelivered = ({ id, deliveredAt }: { id: string; deliveredAt: number }) => {
      markMessageDelivered(id, deliveredAt);
      bump();
    };

    const onRead = ({ id, readAt }: { id: string; readAt: number }) => {
      markMessageRead(id, readAt);
      bump();
    };

    const onDeletedRemote = ({ id }: { id: string }) => {
      markMessageDeletedEverywhere(id, Date.now());
      bump();
    };

    const onReactionSet = async (reaction: IncomingServerReaction) => {
      if (isUserBlocked(reaction.sender_id)) return;
      const conversation = await ensureConversation(reaction.sender_id);
      if (!conversation) return;
      try {
        const identity = await getOrCreateIdentity(email);
        await sodium.ready;
        const decrypted = reaction.sender_public_key
          ? await decryptMessage(
              reaction.ciphertext,
              reaction.nonce,
              sodium.from_base64(reaction.sender_public_key),
              identity.privateKey
            )
          : await decryptFromPeer(
              reaction.sender_id,
              conversation.peer_public_key,
              reaction.ciphertext,
              reaction.nonce,
              identity.privateKey
            );
        const payload: ReactionPayload = JSON.parse(decrypted);
        setPeerReaction(reaction.message_id, payload.emoji);
        bump();
      } catch (err) {
        console.warn("[messaging] failed to process incoming reaction", err);
      }
    };

    const onReactionCleared = ({ messageId }: { messageId: string; senderId: string }) => {
      setPeerReaction(messageId, null);
      bump();
    };

    // Someone else's contact:request/accept/reject relayed to us — see
    // socketServer.ts. These mutate the same conversations table as
    // messages, hence living here rather than a separate context.
    const onContactRequest = async ({ requesterId }: { requesterId: string }) => {
      if (isUserBlocked(requesterId)) return;
      const existing = getConversationById(requesterId);
      if (existing) {
        if (existing.status !== "accepted") setConversationStatus(requesterId, "pending_incoming");
        // A stub conversation can already exist with a stale or never-resolved
        // profile (e.g. an earlier resolve attempt raced a failed profile
        // push and got back a null name) — refresh it here too instead of
        // only ever fixing it up the very first time this request is seen,
        // so the sender's real name/avatar can still surface before the
        // request is accepted rather than staying stuck on one snapshot.
        try {
          const peer = await getUserById(token, requesterId);
          const profileChanged =
            peer.name !== existing.display_name ||
            peer.avatarUrl !== existing.avatar_url ||
            peer.contactNumber !== existing.contact_number;
          if (profileChanged) updateConversationProfile(requesterId, peer.name, peer.avatarUrl, peer.contactNumber);
        } catch (err) {
          console.warn("[messaging] failed to refresh contact request sender", err);
        }
        bump();
        return;
      }
      try {
        const peer = await getUserById(token, requesterId);
        insertConversation({
          id: peer.userId,
          peer_public_key: peer.publicKey,
          display_name: peer.name,
          avatar_url: peer.avatarUrl,
          created_at: Date.now(),
          status: "pending_incoming",
          contact_number: peer.contactNumber,
        });
        bump();
      } catch (err) {
        console.warn("[messaging] failed to resolve contact request sender", err);
      }
    };

    const onContactAccepted = ({ peerId }: { peerId: string }) => {
      setConversationStatus(peerId, "accepted");
      bump();
    };

    const onContactDeclined = ({ peerId }: { peerId: string }) => {
      setConversationStatus(peerId, "declined");
      bump();
    };

    socket.on("message", onMessage);
    socket.on("message:delivered", onDelivered);
    socket.on("message:read", onRead);
    socket.on("message:deleted", onDeletedRemote);
    socket.on("reaction:set", onReactionSet);
    socket.on("reaction:cleared", onReactionCleared);
    socket.on("contact:request", onContactRequest);
    socket.on("contact:accepted", onContactAccepted);
    socket.on("contact:declined", onContactDeclined);
    return () => {
      socket.off("message", onMessage);
      socket.off("message:delivered", onDelivered);
      socket.off("message:read", onRead);
      socket.off("message:deleted", onDeletedRemote);
      socket.off("reaction:set", onReactionSet);
      socket.off("reaction:cleared", onReactionCleared);
      socket.off("contact:request", onContactRequest);
      socket.off("contact:accepted", onContactAccepted);
      socket.off("contact:declined", onContactDeclined);
    };
  }, [token, email]);

  return <MessagingContext.Provider value={{ revision }}>{children}</MessagingContext.Provider>;
}

export function useMessaging(): MessagingContextValue {
  return useContext(MessagingContext);
}
