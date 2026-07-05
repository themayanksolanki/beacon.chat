import type { Server as HttpServer } from "node:http";
import { Server, Socket } from "socket.io";
import { isSessionActive, verifyToken } from "./auth";
import {
  deleteMessageForEveryone,
  getUndeliveredMessages,
  markDelivered,
  markRead,
  storeMessage,
  userExists,
} from "./messages";

interface AuthedSocket extends Socket {
  userId?: string;
}

let io: Server | undefined;

export function createSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: "*" },
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

    for (const pending of getUndeliveredMessages(userId)) {
      socket.emit("message", pending);
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

    socket.on("message:delivered", (payload: { id: string; senderId: string }) => {
      try {
        const deliveredAt = markDelivered(payload.id);
        io!.to(payload.senderId).emit("message:delivered", { id: payload.id, deliveredAt });
      } catch (err) {
        console.error("[socket] message:delivered failed", err);
      }
    });

    socket.on("message:read", (payload: { id: string; senderId: string }) => {
      try {
        const readAt = markRead(payload.id);
        io!.to(payload.senderId).emit("message:read", { id: payload.id, readAt });
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
