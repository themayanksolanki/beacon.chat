import { blockUser, setConversationStatus } from "../db/database";
import { getSocket } from "../network/socket";
import { deleteConversation } from "./deleteConversation";

export type RejectAction = "none" | "block" | "report";

const ACK_TIMEOUT_MS = 10000;

/** Accepts an incoming contact request from `peerId` — used by both the chat list row and ChatScreen's banner. */
export function acceptContactRequest(peerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("contact:accept", { requesterId: peerId }, (err: unknown, ack?: { ok: boolean; error?: string }) => {
        if (err || !ack?.ok) {
          console.warn("[contacts] accept failed", err ?? ack?.error);
          resolve(false);
          return;
        }
        setConversationStatus(peerId, "accepted");
        resolve(true);
      });
  });
}

/**
 * Declines an incoming contact request from `peerId`. Once decided, there's
 * nothing left to act on from this device — the requester's side is what
 * shows 'declined' (only for action 'none', see socketServer.ts) — so the
 * local row is removed regardless of which action was chosen.
 */
export function rejectContactRequest(peerId: string, action: RejectAction, reason?: string): Promise<boolean> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit(
        "contact:reject",
        { requesterId: peerId, action, reason },
        (err: unknown, ack?: { ok: boolean; error?: string }) => {
          if (err || !ack?.ok) {
            console.warn("[contacts] reject failed", err ?? ack?.error);
            resolve(false);
            return;
          }
          if (action === "block") blockUser(peerId);
          deleteConversation(peerId);
          resolve(true);
        }
      );
  });
}
