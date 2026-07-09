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
  type ConversationRow,
  type MessageRow,
} from "../db/database";
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

export type MessagePayload =
  | { kind: "text"; text: string; replyTo?: { id: string; preview: string } }
  | { kind: "voice"; audio: string; durationMs: number; waveform: number[]; replyTo?: { id: string; preview: string } }
  | { kind: "image"; image: string; width: number; height: number; replyTo?: { id: string; preview: string } };

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
}

interface IncomingServerReaction {
  message_id: string;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
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
        const decrypted = await decryptFromPeer(
          message.sender_id,
          conversation.peer_public_key,
          message.ciphertext,
          message.nonce,
          identity.privateKey
        );
        const payload: MessagePayload = JSON.parse(decrypted);
        const audioUri = payload.kind === "voice" ? writeVoiceMessageBase64(payload.audio, message.id) : null;
        const imageUri = payload.kind === "image" ? writeImageMessageBase64(payload.image, message.id) : null;

        const row: MessageRow = {
          id: message.id,
          conversation_id: message.sender_id,
          direction: "incoming",
          plaintext:
            payload.kind === "voice" ? VOICE_MESSAGE_LABEL : payload.kind === "image" ? IMAGE_MESSAGE_LABEL : payload.text,
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
        };
        insertMessage(row);
        getSocket().emit("message:delivered", { id: message.id });
        bump();

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
        const decrypted = await decryptFromPeer(
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
