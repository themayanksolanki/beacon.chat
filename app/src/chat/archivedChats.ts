import { archiveConversation, unarchiveConversation } from "../db/database";
import { getSocket } from "../network/socket";

const ACK_TIMEOUT_MS = 10000;

/** Archives `peerId` server-side first, then mirrors it locally — same request-then-persist order as contactRequests.ts, so a dropped ack never leaves the local cache out of sync with the server. */
export function archiveChat(peerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit(
        "conversation:archive",
        { peerId },
        (err: unknown, ack?: { ok: boolean; archivedAt?: number; error?: string }) => {
          if (err || !ack?.ok) {
            console.warn("[archive] archive failed", err ?? ack?.error);
            resolve(false);
            return;
          }
          archiveConversation(peerId, ack.archivedAt ?? Date.now());
          resolve(true);
        }
      );
  });
}

export function unarchiveChat(peerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit("conversation:unarchive", { peerId }, (err: unknown, ack?: { ok: boolean; error?: string }) => {
        if (err || !ack?.ok) {
          console.warn("[archive] unarchive failed", err ?? ack?.error);
          resolve(false);
          return;
        }
        unarchiveConversation(peerId);
        resolve(true);
      });
  });
}
