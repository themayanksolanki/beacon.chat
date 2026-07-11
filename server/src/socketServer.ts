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
  setReactions,
  storeMessages,
  userExists,
  type OutgoingEnvelope,
} from "./messages";
import { getLastSeen, setLastSeen } from "./presence";
import { setDeviceLastSeen } from "./devices";
import { acceptContact, isAcceptedContact, rejectContact, requestContact, type RejectAction } from "./contacts";

interface AuthedSocket extends Socket {
  userId?: string;
  deviceId?: string;
}

interface ActiveCall {
  callId: string;
  callerId: string;
  calleeId: string;
  // call:invite rings every device the callee is linked on at once (it
  // targets their user room, which every device joins). This flips true the
  // moment ANY of those devices answers, so a second/third device's
  // near-simultaneous call:answer is recognized as redundant instead of
  // being relayed to the caller again — see call:answer below.
  answered: boolean;
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

// Presence is tracked per DEVICE, then aggregated up to "is this user online
// at all" — a user is online iff at least one of their devices has a live
// socket. Socket count per device (rather than a plain Set of device ids)
// so a brief overlap between an old and new connection for the same device
// (reconnect, or the old socket lingering a moment after login-elsewhere
// revocation) doesn't flip that device's — and therefore possibly the
// user's — presence offline and back on.
const onlineDeviceSocketCounts = new Map<string, number>();
const onlineDevicesByUser = new Map<string, Set<string>>();

function isUserOnline(userId: string): boolean {
  return (onlineDevicesByUser.get(userId)?.size ?? 0) > 0;
}

function presenceRoom(userId: string): string {
  return `presence:${userId}`;
}

function deviceRoom(deviceId: string): string {
  return `device:${deviceId}`;
}

let io: Server | undefined;

/**
 * Flushes anything that arrived while this device was offline: queued
 * messages and reactions addressed to THIS device specifically (each
 * recipient device tracks its own delivery independently — see
 * messages.ts). Reactions are marked delivered as soon as they're flushed
 * rather than waiting for a client ack — worst case one is a step behind
 * after a crash, never lost. Deliberately not awaited by the caller — see
 * the comment at its call site in the connection handler.
 */
async function flushUndelivered(socket: AuthedSocket, deviceId: string): Promise<void> {
  for (const pending of await getUndeliveredMessages(deviceId)) {
    socket.emit("message", pending);
  }

  for (const reaction of await getUndeliveredReactions(deviceId)) {
    socket.emit("reaction:set", reaction);
    void markReactionDelivered(reaction.message_id, reaction.sender_id, reaction.recipient_device_id);
  }
}

export function createSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: "*" },
    // Default is 1MB; encrypted voice-note payloads ride through the same
    // message:send event as text and can exceed that.
    maxHttpBufferSize: 15 * 1024 * 1024,
  });

  io.use(async (socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") {
      next(new Error("Missing auth token"));
      return;
    }
    try {
      const payload = verifyToken(token);
      if (!(await isSessionActive(payload))) {
        next(new Error("session_revoked"));
        return;
      }
      socket.userId = payload.userId;
      socket.deviceId = payload.deviceId;
      next();
    } catch {
      next(new Error("Invalid auth token"));
    }
  });

  io.on("connection", (socket: AuthedSocket) => {
    const userId = socket.userId!;
    // Each user gets a private room keyed by their id so messages can be
    // relayed to them regardless of which socket/device they're on. Each
    // device additionally gets its own room, so a device-scoped revoke
    // (same-device re-login, or explicit removal in Settings) can kick just
    // that one device instead of every device the account is linked on.
    socket.join(userId);
    if (socket.deviceId) {
      const deviceId = socket.deviceId;
      socket.join(deviceRoom(deviceId));

      onlineDeviceSocketCounts.set(deviceId, (onlineDeviceSocketCounts.get(deviceId) ?? 0) + 1);
      let userDevices = onlineDevicesByUser.get(userId);
      const wasUserOffline = !userDevices || userDevices.size === 0;
      if (!userDevices) {
        userDevices = new Set();
        onlineDevicesByUser.set(userId, userDevices);
      }
      userDevices.add(deviceId);
      // Only the FIRST device coming online flips the user's aggregate
      // presence — a second device connecting while the first is already up
      // doesn't re-announce "online" (it already is).
      if (wasUserOffline) {
        io!.to(presenceRoom(userId)).emit("presence:update", { userId, online: true, lastSeenAt: null });
      }
    }

    // Fire-and-forget, deliberately not awaited: every socket.on(...) listener
    // below must be registered synchronously, in this same tick, before
    // control ever yields to the event loop. Awaiting here first would leave
    // a window — after the client sees "connect" but before its listeners
    // exist — where anything the client emits immediately (as a fast test or
    // a real client racing to reconnect might) is silently dropped.
    if (socket.deviceId) void flushUndelivered(socket, socket.deviceId);

    socket.on(
      "message:send",
      async (
        payload: { id: string; recipientId: string; envelopes: OutgoingEnvelope[] },
        ack?: (response: { ok: true; createdAt: number } | { ok: false; error: string }) => void
      ) => {
        try {
          // recipientId is client-supplied; storeMessages' FK constraint would
          // otherwise throw here and — uncaught — take down the whole process
          // for every connected user over one bad payload.
          if (!(await userExists(payload.recipientId))) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }
          if (!(await isAcceptedContact(userId, payload.recipientId))) {
            ack?.({ ok: false, error: "not_contacts" });
            return;
          }

          // One envelope per device the client encrypted for; storeMessages
          // silently drops any addressed to a device that's no longer active
          // (a stale entry in the sender's cached device list — a normal
          // race, not an error) and returns one row per envelope it kept.
          const messages = await storeMessages({
            clientId: payload.id,
            senderId: userId,
            senderDeviceId: socket.deviceId ?? null,
            recipientId: payload.recipientId,
            envelopes: payload.envelopes,
          });

          if (messages.length === 0) {
            ack?.({ ok: false, error: "no_active_devices" });
            return;
          }

          for (const message of messages) {
            io!.to(deviceRoom(message.recipient_device_id)).emit("message", message);
          }
          ack?.({ ok: true, createdAt: messages[0].created_at });
        } catch (err) {
          console.error("[socket] message:send failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on("message:delivered", async (payload: { id: string }) => {
      try {
        if (!socket.deviceId) return;
        const result = await markDelivered(payload.id, socket.deviceId, userId);
        if (!result.ok) return;
        io!.to(result.senderId).emit("message:delivered", { id: payload.id, deliveredAt: result.at });
      } catch (err) {
        console.error("[socket] message:delivered failed", err);
      }
    });

    socket.on("message:read", async (payload: { id: string }) => {
      try {
        if (!socket.deviceId) return;
        const result = await markRead(payload.id, socket.deviceId, userId);
        if (!result.ok) return;
        io!.to(result.senderId).emit("message:read", { id: payload.id, readAt: result.at });
      } catch (err) {
        console.error("[socket] message:read failed", err);
      }
    });

    socket.on(
      "message:delete",
      async (payload: { id: string }, ack?: (response: { ok: true } | { ok: false; error: string }) => void) => {
        try {
          const result = await deleteMessageForEveryone(payload.id, userId);
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
      async (
        payload: { messageId: string; recipientId: string; envelopes: OutgoingEnvelope[] },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          if (!(await userExists(payload.recipientId))) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }
          if (!(await isAcceptedContact(userId, payload.recipientId))) {
            ack?.({ ok: false, error: "not_contacts" });
            return;
          }
          // One envelope per active recipient device, same fan-out shape as
          // message:send above.
          const reactions = await setReactions({
            messageId: payload.messageId,
            senderId: userId,
            senderDeviceId: socket.deviceId ?? null,
            recipientId: payload.recipientId,
            envelopes: payload.envelopes,
          });
          if (reactions.length === 0) {
            ack?.({ ok: false, error: "no_active_devices" });
            return;
          }
          for (const reaction of reactions) {
            io!.to(deviceRoom(reaction.recipient_device_id)).emit("reaction:set", reaction);
          }
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] reaction:set failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on(
      "reaction:clear",
      async (
        payload: { messageId: string; recipientId: string },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          await clearReaction(payload.messageId, userId);
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
      async (
        payload: { userIds: string[] },
        ack?: (snapshot: { userId: string; online: boolean; lastSeenAt: number | null }[]) => void
      ) => {
        const snapshot = await Promise.all(
          payload.userIds.map(async (id) => {
            socket.join(presenceRoom(id));
            const online = isUserOnline(id);
            return { userId: id, online, lastSeenAt: online ? null : await getLastSeen(id) };
          })
        );
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

    // --- Recording indicators ---
    // Same pure ephemeral relay pattern as typing above — no server-side state.

    socket.on("recording:start", (payload: { recipientId: string }) => {
      try {
        io!.to(payload.recipientId).emit("recording:update", { userId, recording: true });
      } catch (err) {
        console.error("[socket] recording:start failed", err);
      }
    });

    socket.on("recording:stop", (payload: { recipientId: string }) => {
      try {
        io!.to(payload.recipientId).emit("recording:update", { userId, recording: false });
      } catch (err) {
        console.error("[socket] recording:stop failed", err);
      }
    });

    // --- Contact requests (gate for message:send/reaction:set/call:invite above) ---

    socket.on(
      "contact:request",
      async (payload: { recipientId: string }, ack?: (response: { ok: true; status: "pending" | "accepted" } | { ok: false; error: string }) => void) => {
        try {
          if (payload.recipientId === userId) {
            ack?.({ ok: false, error: "invalid_recipient" });
            return;
          }
          if (!(await userExists(payload.recipientId))) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }
          const result = await requestContact(userId, payload.recipientId);
          if (result.status === "accepted") {
            // Mutual: the recipient had already requested us — tell them
            // their own pending outgoing request just became accepted.
            io!.to(payload.recipientId).emit("contact:accepted", { peerId: userId });
          } else {
            io!.to(payload.recipientId).emit("contact:request", { requesterId: userId });
          }
          ack?.({ ok: true, status: result.status });
        } catch (err) {
          console.error("[socket] contact:request failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on(
      "contact:accept",
      async (payload: { requesterId: string }, ack?: (response: { ok: true } | { ok: false; error: string }) => void) => {
        try {
          const result = await acceptContact(payload.requesterId, userId);
          if (!result.ok) {
            ack?.({ ok: false, error: result.error });
            return;
          }
          io!.to(payload.requesterId).emit("contact:accepted", { peerId: userId });
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] contact:accept failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    socket.on(
      "contact:reject",
      async (
        payload: { requesterId: string; action: RejectAction; reason?: string },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          const result = await rejectContact(payload.requesterId, userId, payload.action, payload.reason);
          if (!result.ok) {
            ack?.({ ok: false, error: result.error });
            return;
          }
          // Block/report stay silent to the requester — only a plain decline
          // is relayed back, so a report/block never tips off the sender.
          if (payload.action === "none") {
            io!.to(payload.requesterId).emit("contact:declined", { peerId: userId });
          }
          ack?.({ ok: true });
        } catch (err) {
          console.error("[socket] contact:reject failed", err);
          ack?.({ ok: false, error: "internal_error" });
        }
      }
    );

    // --- Calling (WebRTC signaling relay only — no media touches this server) ---

    socket.on(
      "call:invite",
      async (
        payload: { callId: string; calleeId: string; kind: "audio" | "video"; sdp: unknown },
        ack?: (response: { ok: true } | { ok: false; error: string }) => void
      ) => {
        try {
          if (!(await userExists(payload.calleeId))) {
            ack?.({ ok: false, error: "recipient_not_found" });
            return;
          }
          if (!(await isAcceptedContact(userId, payload.calleeId))) {
            ack?.({ ok: false, error: "not_contacts" });
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
            answered: false,
          });
          userActiveCall.set(userId, payload.callId);
          userActiveCall.set(payload.calleeId, payload.callId);

          // Targets the callee's user room, which every one of their linked
          // devices joined on connect — so this already rings all of them
          // at once, with no per-device fan-out needed here.
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
        // Another of the callee's devices already answered this same call —
        // ignore a redundant/racing answer instead of relaying it to the
        // caller a second time (which would confuse WebRTC renegotiation).
        if (call.answered) return;
        call.answered = true;

        io!.to(call.callerId).emit("call:answer", { callId: payload.callId, sdp: payload.sdp });
        // Tell every OTHER device still ringing for this call to stop —
        // `socket.to` (as opposed to `io.to`) excludes the answering
        // socket itself, so only the sibling devices get this.
        socket.to(userId).emit("call:cancel", { callId: payload.callId });
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

    // Camera on/off is purely local (track.enabled), so the other party has
    // no way to know it happened without this — relayed so they can swap
    // their remote video view for the peer's avatar instead of a frozen frame.
    socket.on("call:camera-state", (payload: { callId: string; cameraOn: boolean }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
        io!.to(otherParty(call, userId)).emit("call:camera-state", {
          callId: payload.callId,
          cameraOn: payload.cameraOn,
        });
      } catch (err) {
        console.error("[socket] call:camera-state failed", err);
      }
    });

    // Mid-call renegotiation (e.g. adding a video track to a call that
    // started audio-only) — same relay-only shape as call:answer, but must
    // not touch activeCalls/userActiveCall bookkeeping, which stays owned by
    // the original invite/answer/end flow.
    socket.on("call:renegotiate-offer", (payload: { callId: string; sdp: unknown; kind: "audio" | "video" }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
        io!.to(otherParty(call, userId)).emit("call:renegotiate-offer", {
          callId: payload.callId,
          sdp: payload.sdp,
          kind: payload.kind,
        });
      } catch (err) {
        console.error("[socket] call:renegotiate-offer failed", err);
      }
    });

    socket.on("call:renegotiate-answer", (payload: { callId: string; sdp: unknown }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
        io!.to(otherParty(call, userId)).emit("call:renegotiate-answer", {
          callId: payload.callId,
          sdp: payload.sdp,
        });
      } catch (err) {
        console.error("[socket] call:renegotiate-answer failed", err);
      }
    });

    socket.on("call:reject", (payload: { callId: string }) => {
      try {
        const call = activeCalls.get(payload.callId);
        if (!call || call.calleeId !== userId) return;
        // Same "tell the other ringing devices to stop" as call:answer above
        // — declining on one device should stop every other linked device
        // from still ringing, not just this one.
        socket.to(userId).emit("call:cancel", { callId: payload.callId });
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

      if (!socket.deviceId) return;
      const deviceId = socket.deviceId;

      const remainingForDevice = (onlineDeviceSocketCounts.get(deviceId) ?? 1) - 1;
      if (remainingForDevice > 0) {
        onlineDeviceSocketCounts.set(deviceId, remainingForDevice);
        return;
      }

      // This device's last live socket just closed — it's genuinely offline
      // now, so record ITS OWN last-seen (useful for a future Linked Devices
      // "active 2h ago" display) independently of whether the user as a
      // whole is still online on another device.
      onlineDeviceSocketCounts.delete(deviceId);
      const deviceLastSeenAt = Date.now();
      setDeviceLastSeen(deviceId, deviceLastSeenAt).catch((err) =>
        console.error("[socket] setDeviceLastSeen failed", err)
      );

      const userDevices = onlineDevicesByUser.get(userId);
      userDevices?.delete(deviceId);
      // Only flip the user's aggregate presence to offline once EVERY
      // device has disconnected — a sibling device still being connected
      // means the user is still online, just not on this one.
      if (!userDevices || userDevices.size > 0) return;

      onlineDevicesByUser.delete(userId);
      const lastSeenAt = Date.now();
      setLastSeen(userId, lastSeenAt).catch((err) => console.error("[socket] setLastSeen failed", err));
      io!.to(presenceRoom(userId)).emit("presence:update", { userId, online: false, lastSeenAt });
    });
  });

  return io;
}

/**
 * Called right after a device re-authenticates (same deviceId logging in
 * again). Anyone still connected under that device's old session is told
 * explicitly and dropped, so it logs itself out immediately instead of
 * waiting for its next API call to 401 — without touching any *other*
 * device the account is linked on. Also used by DELETE /devices/:id to kick
 * a device the user explicitly removed from Settings.
 */
export async function revokeDeviceSessions(deviceId: string): Promise<void> {
  if (!io) return;
  const room = deviceRoom(deviceId);
  io.to(room).emit("session:revoked");
  await io.in(room).disconnectSockets(true);
}

/**
 * Kicks every device the account is linked on at once — used only for
 * account deletion, where signing out everywhere is the point.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  if (!io) return;
  io.to(userId).emit("session:revoked");
  await io.in(userId).disconnectSockets(true);
}
