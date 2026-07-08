import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { messages, reactions, users } from "./schema";

export type MessageRow = typeof messages.$inferSelect;

export function userExists(id: string): boolean {
  return !!db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
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

  db.insert(messages).values(row).run();

  return row;
}

export function getUndeliveredMessages(recipientId: string): MessageRow[] {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.recipient_id, recipientId), isNull(messages.delivered_at)))
    .orderBy(asc(messages.created_at))
    .all();
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
  const message = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!message) return { ok: false, error: "not_found" };
  if (message.recipient_id !== requesterId) return { ok: false, error: "not_recipient" };

  const deliveredAt = Date.now();
  db.update(messages).set({ delivered_at: deliveredAt }).where(eq(messages.id, messageId)).run();
  return { ok: true, senderId: message.sender_id, at: deliveredAt };
}

export function markRead(messageId: string, requesterId: string): MarkResult {
  const message = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!message) return { ok: false, error: "not_found" };
  if (message.recipient_id !== requesterId) return { ok: false, error: "not_recipient" };

  const readAt = Date.now();
  db.update(messages).set({ read_at: readAt }).where(eq(messages.id, messageId)).run();
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
  const message = db.select().from(messages).where(eq(messages.id, id)).get();
  if (!message) return { ok: false, error: "not_found" };
  if (message.sender_id !== requesterId) return { ok: false, error: "not_sender" };
  if (Date.now() - message.created_at > DELETE_FOR_EVERYONE_WINDOW_MS) return { ok: false, error: "too_late" };

  db.delete(messages).where(eq(messages.id, id)).run();
  return { ok: true, message };
}

export type ReactionRow = typeof reactions.$inferSelect;

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

  db.insert(reactions)
    .values(row)
    .onConflictDoUpdate({
      target: [reactions.message_id, reactions.sender_id],
      set: {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        created_at: row.created_at,
        delivered_at: null,
      },
    })
    .run();

  return row;
}

export function clearReaction(messageId: string, senderId: string): void {
  db.delete(reactions)
    .where(and(eq(reactions.message_id, messageId), eq(reactions.sender_id, senderId)))
    .run();
}

export function getUndeliveredReactions(recipientId: string): ReactionRow[] {
  return db
    .select()
    .from(reactions)
    .where(and(eq(reactions.recipient_id, recipientId), isNull(reactions.delivered_at)))
    .orderBy(asc(reactions.created_at))
    .all();
}

export function markReactionDelivered(messageId: string, senderId: string): void {
  db.update(reactions)
    .set({ delivered_at: Date.now() })
    .where(and(eq(reactions.message_id, messageId), eq(reactions.sender_id, senderId)))
    .run();
}
