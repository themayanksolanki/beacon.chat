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

export function userExists(id: string): boolean {
  return !!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id);
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

export type MarkResult =
  | { ok: true; senderId: string; at: number }
  | { ok: false; error: "not_found" | "not_recipient" };

/**
 * requesterId must be the authenticated socket's own userId, not a
 * client-supplied value — otherwise any user could mark someone else's
 * message delivered/read and spoof a receipt to an arbitrary room. The
 * sender to notify is read back from the row rather than trusted from the
 * client for the same reason.
 */
export function markDelivered(messageId: string, requesterId: string): MarkResult {
  const message = db.prepare<[string], MessageRow>("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (!message) return { ok: false, error: "not_found" };
  if (message.recipient_id !== requesterId) return { ok: false, error: "not_recipient" };

  const deliveredAt = Date.now();
  db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ?").run(deliveredAt, messageId);
  return { ok: true, senderId: message.sender_id, at: deliveredAt };
}

export function markRead(messageId: string, requesterId: string): MarkResult {
  const message = db.prepare<[string], MessageRow>("SELECT * FROM messages WHERE id = ?").get(messageId);
  if (!message) return { ok: false, error: "not_found" };
  if (message.recipient_id !== requesterId) return { ok: false, error: "not_recipient" };

  const readAt = Date.now();
  db.prepare("UPDATE messages SET read_at = ? WHERE id = ?").run(readAt, messageId);
  return { ok: true, senderId: message.sender_id, at: readAt };
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

export interface ReactionRow {
  message_id: string;
  sender_id: string;
  recipient_id: string;
  ciphertext: string;
  nonce: string;
  created_at: number;
  delivered_at: number | null;
}

/** One reaction per (message, reactor) — reacting again just overwrites the previous emoji. */
export function setReaction(input: {
  messageId: string;
  senderId: string;
  recipientId: string;
  ciphertext: string;
  nonce: string;
}): ReactionRow {
  const row: ReactionRow = {
    message_id: input.messageId,
    sender_id: input.senderId,
    recipient_id: input.recipientId,
    ciphertext: input.ciphertext,
    nonce: input.nonce,
    created_at: Date.now(),
    delivered_at: null,
  };

  db.prepare(
    `INSERT INTO reactions (message_id, sender_id, recipient_id, ciphertext, nonce, created_at, delivered_at)
     VALUES (@message_id, @sender_id, @recipient_id, @ciphertext, @nonce, @created_at, @delivered_at)
     ON CONFLICT(message_id, sender_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       nonce = excluded.nonce,
       created_at = excluded.created_at,
       delivered_at = NULL`
  ).run(row);

  return row;
}

export function clearReaction(messageId: string, senderId: string): void {
  db.prepare("DELETE FROM reactions WHERE message_id = ? AND sender_id = ?").run(messageId, senderId);
}

export function getUndeliveredReactions(recipientId: string): ReactionRow[] {
  return db
    .prepare<[string], ReactionRow>(
      "SELECT * FROM reactions WHERE recipient_id = ? AND delivered_at IS NULL ORDER BY created_at ASC"
    )
    .all(recipientId);
}

export function markReactionDelivered(messageId: string, senderId: string): void {
  db.prepare("UPDATE reactions SET delivered_at = ? WHERE message_id = ? AND sender_id = ?").run(
    Date.now(),
    messageId,
    senderId
  );
}
