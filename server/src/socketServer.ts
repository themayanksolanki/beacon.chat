import type { Server as HttpServer } from "node:http";
import { Server, Socket } from "socket.io";
import { isSessionActive, verifyToken } from "./auth";
import { deleteMessageForEveryone, getUndeliveredMessages, markDelivered, markRead, storeMessage } from "./messages";

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
        ack?: (response: { createdAt: number }) => void
      ) => {
        const message = storeMessage({
          id: payload.id,
          senderId: userId,
          recipientId: payload.recipientId,
          ciphertext: payload.ciphertext,
          nonce: payload.nonce,
        });

        io!.to(payload.recipientId).emit("message", message);
        ack?.({ createdAt: message.created_at });
      }
    );

    socket.on("message:delivered", (payload: { id: string; senderId: string }) => {
      const deliveredAt = markDelivered(payload.id);
      io!.to(payload.senderId).emit("message:delivered", { id: payload.id, deliveredAt });
    });

    socket.on("message:read", (payload: { id: string; senderId: string }) => {
      const readAt = markRead(payload.id);
      io!.to(payload.senderId).emit("message:read", { id: payload.id, readAt });
    });

    socket.on(
      "message:delete",
      (payload: { id: string }, ack?: (response: { ok: true } | { ok: false; error: string }) => void) => {
        const result = deleteMessageForEveryone(payload.id, userId);
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        io!.to(result.message.recipient_id).emit("message:deleted", { id: result.message.id });
        ack?.({ ok: true });
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
