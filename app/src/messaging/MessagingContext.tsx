import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import sodium from "react-native-libsodium";

import { useAuth } from "../auth/AuthContext";
import { writeVoiceMessageBase64 } from "../audio/voiceStorage";
import { decryptMessage, getOrCreateIdentity } from "../crypto/identity";
import {
  getConversationById,
  insertMessage,
  isUserBlocked,
  markMessageDeletedEverywhere,
  markMessageDelivered,
  markMessageRead,
  setPeerReaction,
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

    const onMessage = async (message: IncomingServerMessage) => {
      if (isUserBlocked(message.sender_id)) return;
      const conversation = getConversationById(message.sender_id);
      if (!conversation) return;

      try {
        const identity = await getOrCreateIdentity(email);
        await sodium.ready;
        const peerPublicKey = sodium.from_base64(conversation.peer_public_key);
        const decrypted = await decryptMessage(
          message.ciphertext,
          message.nonce,
          peerPublicKey,
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
      const conversation = getConversationById(reaction.sender_id);
      if (!conversation) return;
      try {
        const identity = await getOrCreateIdentity(email);
        await sodium.ready;
        const peerPublicKey = sodium.from_base64(conversation.peer_public_key);
        const decrypted = await decryptMessage(
          reaction.ciphertext,
          reaction.nonce,
          peerPublicKey,
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

    socket.on("message", onMessage);
    socket.on("message:delivered", onDelivered);
    socket.on("message:read", onRead);
    socket.on("message:deleted", onDeletedRemote);
    socket.on("reaction:set", onReactionSet);
    socket.on("reaction:cleared", onReactionCleared);
    return () => {
      socket.off("message", onMessage);
      socket.off("message:delivered", onDelivered);
      socket.off("message:read", onRead);
      socket.off("message:deleted", onDeletedRemote);
      socket.off("reaction:set", onReactionSet);
      socket.off("reaction:cleared", onReactionCleared);
    };
  }, [token, email]);

  return <MessagingContext.Provider value={{ revision }}>{children}</MessagingContext.Provider>;
}

export function useMessaging(): MessagingContextValue {
  return useContext(MessagingContext);
}
