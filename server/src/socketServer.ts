import type { Server as HttpServer } from "node:http";
import { Server, Socket } from "socket.io";
import { isSessionActive, verifyToken } from "./auth";
import {
  clearReaction,
  deleteMessageForEveryone,
  getUndeliveredMessages,
  getUndeliveredReactions,
  markDelivered,
  markReactionDelivered,
  markRead,
  setReaction,
  storeMessage,
  userExists,
} from "./messages";
import { getLastSeen, setLastSeen } from "./presence";

interface AuthedSocket extends Socket {
  userId?: string;
}

interface ActiveCall {
  callId: string;
  callerId: string;
  calleeId: string;
}

// Ephemeral signaling state only — calls aren't persisted server-side, so a
// restart just drops any in-flight calls (clients time out and redial).
const activeCalls = new Map<string, ActiveCall>();
const userActiveCall = new Map<string, string>();

function otherParty(call: ActiveCall, userId: string): string {
  return userId === call.callerId ? call.calleeId : call.callerId;
}

function endActiveCall(callId: string, io: Server, reason: string, notify: string[]): void {
  const call = activeCalls.get(callId);
  if (!call) return;
  activeCalls.delete(callId);
  userActiveCall.delete(call.callerId);
  userActiveCall.delete(call.calleeId);
  for (const userId of notify) {
    io.to(userId).emit("call:end", { callId, reason });
  }
}

// Socket count per user rather than a plain Set, so a brief overlap between
// an old and new connection (reconnect, or the old device's socket lingering
// a moment after login-elsewhere revocation) doesn't flip presence offline
// and back on.
const onlineUsers = new Map<string, number>();

function presenceRoom(userId: string): string {
  return `presence:${userId}`;
}

let io: Server | undefined;

export function createSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: "*" },
    // Default is 1MB; encrypted voice-note payloads ride through the same
    // message:send event as text and can exceed that.
    maxHttpBufferSize: 15 * 1024 * 1024,
  });

  io.use((socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") {
      next(new Error("Missing auth token"));
      return;
    }
    try {
      const payload = verifyToken(token);
      if (!isSessionActive(payload)) {
        next(new Error("session_revoked"));
        return;
      }
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error("Invalid auth token"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    const userId = socket.userId!;
    // Each user gets a private room keyed by their id so messages can be
    // relayed to them regardless of which socket/device they're on.
    socket.join(userId);

    const wasOffline = !onlineUsers.has(userId);
    onlineUsers.set(userId, (onlineUsers.get(userId) ?? 0) + 1);
    if (wasOffline) {
      io!.to(presenceRoom(userId)).emit("presence:update", { userId, online: true, lastSeenAt: null });
    }

    for (const pending of getUndeliveredMessages(userId)) {
      socket.emit("message", pending);
    }

    // Fire-and-forget: marked delivered as soon as it's flushed rather than
    // waiting for a client ack, same tradeoff as the rest of presence-style
    // metadata — worst case a reaction is a step behind after a crash, never lost data.
    for (const reaction of getUndeliveredReactions(userId)) {
      socket.emit("reaction:set", reaction);
      markReactionDelivered(reaction.message_id, reaction.sender_id);
    }

    socket.on(
      "message:send",
      (
        payload: { id: string; recipientId: string; ciphertext: string; nonce: string },
        ack?: (response: { ok: true; createdAt: number } | { ok: false; error: string }) => void
      ) => {
        try {
          // recipientId is client-supplied; storeMessage's FK constraint would
          // otherwise throw here and — uncaught — take down the whole process
          // for every connected user over one bad payload.
          if (!userExists(payload.recipientId)) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }

          const message = storeMessage({
            id: payload.id,
            senderId: userId,
            recipientId: payload.recipientId,
            ciphertext: payload.ciphertext,
            nonce: payload.nonce,
          });

          io!.to(payload.recipientId).emit("message", message);
          ack?.({ ok: true, createdAt: message.created_at });
        } catch (err) {
          console.error("[socket] message:send failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on("message:delivered", (payload: { id: string }) => {
      try {
        const result = markDelivered(payload.id, userId);
        if (!result.ok) return;
        io!.to(result.senderId).emit("message:delivered", { id: payload.id, deliveredAt: result.at });
      } catch (err) {
        console.error("[socket] message:delivered failed", err);
      }
    });

    socket.on("message:read", (payload: { id: string }) => {
      try {
        const result = markRead(payload.id, userId);
        if (!result.ok) return;
        io!.to(result.senderId).emit("message:read", { id: payload.id, readAt: result.at });
      } catch (err) {
        console.error("[socket] message:read failed", err);
      }
    });

    socket.on(
      "message:delete",
      (payload: { id: string }, ack?: (response: { ok: true } | { ok: false; error: string }) => void) => {
        try {
          const result = deleteMessageForEveryone(payload.id, userId);
          if (!result.ok) {
            ack?.({ ok: false, error: result.error });
            return;
          }
          io!.to(result.message.recipient_id).emit("message:deleted", { id: result.message.id });
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] message:delete failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on(
      "reaction:set",
      (
        payload: { messageId: string; recipientId: string; ciphertext: string; nonce: string },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          if (!userExists(payload.recipientId)) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }
          const reaction = setReaction({
            messageId: payload.messageId,
            senderId: userId,
            recipientId: payload.recipientId,
            ciphertext: payload.ciphertext,
            nonce: payload.nonce,
          });
          io!.to(payload.recipientId).emit("reaction:set", reaction);
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] reaction:set failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on(
      "reaction:clear",
      (
        payload: { messageId: string; recipientId: string },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          clearReaction(payload.messageId, userId);
          io!.to(payload.recipientId).emit("reaction:cleared", { messageId: payload.messageId, senderId: userId });
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] reaction:clear failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on(
      "presence:subscribe",
      (
        payload: { userIds: string[] },
        ack?: (snapshot: { userId: string; online: boolean; lastSeenAt: number | null }[]) => void
      ) => {
        const snapshot = payload.userIds.map((id) => {
          socket.join(presenceRoom(id));
          const online = onlineUsers.has(id);
          return { userId: id, online, lastSeenAt: online ? null : getLastSeen(id) };
        });
        ack?.(snapshot);
      }
    );

    // --- Typing indicators ---
    // Pure ephemeral relay, like the ICE candidates below: never persisted,
    // and the server holds no state on who's typing to whom. A dropped
    // connection just means the recipient's own client-side timeout clears
    // the indicator (see ChatScreen) instead of the server having to notice
    // the disconnect and emit an explicit stop on the sender's behalf.

    socket.on("typing:start", (payload: { recipientId: string }) => {
      try {
        io!.to(payload.recipientId).emit("typing:update", { userId, typing: true });
      } catch (err) {
        console.error("[socket] typing:start failed", err);
      }
    });

    socket.on("typing:stop", (payload: { recipientId: string }) => {
      try {
        io!.to(payload.recipientId).emit("typing:update", { userId, typing: false });
      } catch (err) {
        console.error("[socket] typing:stop failed", err);
      }
    });

    // --- Calling (WebRTC signaling relay only — no media touches this server) ---

    socket.on(
      "call:invite",
      (
        payload: { callId: string; calleeId: string; kind: "audio" | "video"; sdp: unknown },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          if (!userExists(payload.calleeId)) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }
          if (userActiveCall.has(userId) || userActiveCall.has(payload.calleeId)) {
            ack?.({ ok: false, error: "busy" });
            return;
          }

          activeCalls.set(payload.callId, {
            callId: payload.callId,
            callerId: userId,
            calleeId: payload.calleeId,
          });
          userActiveCall.set(userId, payload.callId);
          userActiveCall.set(payload.calleeId, payload.callId);

          io!.to(payload.calleeId).emit("call:invite", {
            callId: payload.callId,
            callerId: userId,
            kind: payload.kind,
            sdp: payload.sdp,
          });
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] call:invite failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on("call:answer", (payload: { callId: string; sdp: unknown }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || call.calleeId !== userId) return;
        io!.to(call.callerId).emit("call:answer", { callId: payload.callId, sdp: payload.sdp });
      } catch (err) {
        console.error("[socket] call:answer failed", err);
      }
    });

    socket.on("call:ice-candidate", (payload: { callId: string; candidate: unknown }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
        io!.to(otherParty(call, userId)).emit("call:ice-candidate", {
          callId: payload.callId,
          candidate: payload.candidate,
        });
      } catch (err) {
        console.error("[socket] call:ice-candidate failed", err);
      }
    });

    socket.on("call:reject", (payload: { callId: string }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || call.calleeId !== userId) return;
        endActiveCall(payload.callId, io!, "rejected", [call.callerId]);
      } catch (err) {
        console.error("[socket] call:reject failed", err);
      }
    });

    socket.on("call:end", (payload: { callId: string }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
        endActiveCall(payload.callId, io!, "ended", [otherParty(call, userId)]);
      } catch (err) {
        console.error("[socket] call:end failed", err);
      }
    });

    socket.on("disconnect", () => {
      const callId = userActiveCall.get(userId);
      if (callId) {
        const call = activeCalls.get(callId);
        if (call) endActiveCall(callId, io!, "disconnected", [otherParty(call, userId)]);
      }

      const remaining = (onlineUsers.get(userId) ?? 1) - 1;
      if (remaining > 0) {
        onlineUsers.set(userId, remaining);
        return;
      }
      onlineUsers.delete(userId);
      const lastSeenAt = Date.now();
      setLastSeen(userId, lastSeenAt);
      io!.to(presenceRoom(userId)).emit("presence:update", { userId, online: false, lastSeenAt });
    });
  });

  return io;
}

/**
 * Called right after a new session is issued for a user (login on another
 * device). Anyone still connected under the old session is told explicitly
 * and dropped, so the previous device logs itself out immediately instead
 * of waiting for its next API call to 401.
 */
export async function revokeOtherSessions(userId: string): Promise<void> {
  if (!io) return;
  io.to(userId).emit("session:revoked");
  await io.in(userId).disconnectSockets(true);
}
