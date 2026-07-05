import { db } from "./db";

export interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

/**
 * The message id is generated client-side (by the sender) rather than here,
 * so the sender's own local copy and the recipient's delivered copy share
 * one id — that's what lets delivered/read receipts be relayed back to the
 * right local row.
 */
export function storeMessage(input: {
  id: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  nonce: string;
}): MessageRow {
  const row: MessageRow = {
    id: input.id,
    sender_id: input.senderId,
    recipient_id: input.recipientId,
    ciphertext: input.ciphertext,
    nonce: input.nonce,
    created_at: Date.now(),
    delivered_at: null,
    read_at: null,
  };

  
  db.prepare(
    `INSERT INTO messages (id, sender_id, recipient_id, ciphertext, nonce, created_at, delivered_at, read_at)
     VALUES (@id, @sender_id, @recipient_id, @ciphertext, @nonce, @created_at, @delivered_at, @read_at)`
  ).run(row);

  return row;
}

export function getUndeliveredMessages(recipientId: string): MessageRow[] {
  return db
    .prepare<[string], MessageRow>(
      "SELECT * FROM messages WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY created_at ASC"
    )
    .all(recipientId);
}

export function markDelivered(messageId: string): number {
  const deliveredAt = Date.now();
  db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ?").run(deliveredAt, messageId);
  return deliveredAt;
}

export function markRead(messageId: string): number {
  const readAt = Date.now();
  db.prepare("UPDATE messages SET read_at = ? WHERE id = ?").run(readAt, messageId);
  return readAt;
}

export const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 60 * 60 * 1000;

export type DeleteForEveryoneResult =
  | { ok: true; message: MessageRow }
  | { ok: false; error: "not_found" | "not_sender" | "too_late" };

/**
 * Only the original sender can delete for everyone, and only within the
 * time window — enforced here since the client's own check is just UX, not
 * a security boundary.
 */
export function deleteMessageForEveryone(id: string, requesterId: string): DeleteForEveryoneResult {
  const message = db.prepare<[string], MessageRow>("SELECT * FROM messages WHERE id = ?").get(id);
  if (!message) return { ok: false, error: "not_found" };
  if (message.sender_id !== requesterId) return { ok: false, error: "not_sender" };
  if (Date.now() - message.created_at > DELETE_FOR_EVERYONE_WINDOW_MS) return { ok: false, error: "too_late" };

  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  return { ok: true, message };
}
