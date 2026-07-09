import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { contacts, messages, reports } from "./schema";

export type ContactStatus = "pending" | "accepted" | "rejected";
export type RejectAction = "none" | "block" | "report";

// One row per relationship regardless of who acted first — sort the pair so
// (A requests B) and (B requests A) always land on the same row.
function canonicalPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

function getContactRow(idA: string, idB: string) {
  const [a, b] = canonicalPair(idA, idB);
  return db.select().from(contacts).where(and(eq(contacts.user_a_id, a), eq(contacts.user_b_id, b))).get();
}

export function isAcceptedContact(idA: string, idB: string): boolean {
  return getContactRow(idA, idB)?.status === "accepted";
}

export function requestContact(requesterId: string, recipientId: string): { status: "pending" | "accepted" } {
  const [a, b] = canonicalPair(requesterId, recipientId);
  const existing = getContactRow(requesterId, recipientId);

  if (existing) {
    if (existing.status === "accepted") return { status: "accepted" };
    if (existing.status === "pending") {
      if (existing.requested_by === requesterId) return { status: "pending" }; // idempotent re-request
      // The other side already requested us — mutual request, auto-accept.
      db.update(contacts)
        .set({ status: "accepted", responded_at: Date.now() })
        .where(and(eq(contacts.user_a_id, a), eq(contacts.user_b_id, b)))
        .run();
      return { status: "accepted" };
    }
    // status === 'rejected' -> fall through and overwrite with a fresh request.
  }

  const row = {
    id: randomUUID(),
    user_a_id: a,
    user_b_id: b,
    status: "pending" as const,
    requested_by: requesterId,
    created_at: Date.now(),
    responded_at: null,
  };
  db.insert(contacts)
    .values(row)
    .onConflictDoUpdate({
      target: [contacts.user_a_id, contacts.user_b_id],
      set: { status: row.status, requested_by: row.requested_by, created_at: row.created_at, responded_at: null },
    })
    .run();
  return { status: "pending" };
}

export type ContactActionResult = { ok: true } | { ok: false; error: "no_pending_request" };

export function acceptContact(requesterId: string, recipientId: string): ContactActionResult {
  const [a, b] = canonicalPair(requesterId, recipientId);
  const existing = getContactRow(requesterId, recipientId);
  if (!existing || existing.status !== "pending" || existing.requested_by !== requesterId) {
    return { ok: false, error: "no_pending_request" };
  }
  db.update(contacts)
    .set({ status: "accepted", responded_at: Date.now() })
    .where(and(eq(contacts.user_a_id, a), eq(contacts.user_b_id, b)))
    .run();
  return { ok: true };
}

export function rejectContact(
  requesterId: string,
  recipientId: string,
  action: RejectAction,
  reason?: string
): ContactActionResult {
  const [a, b] = canonicalPair(requesterId, recipientId);
  const existing = getContactRow(requesterId, recipientId);
  if (!existing || existing.status !== "pending" || existing.requested_by !== requesterId) {
    return { ok: false, error: "no_pending_request" };
  }
  db.update(contacts)
    .set({ status: "rejected", responded_at: Date.now() })
    .where(and(eq(contacts.user_a_id, a), eq(contacts.user_b_id, b)))
    .run();

  if (action === "report") {
    db.insert(reports)
      .values({
        id: randomUUID(),
        reporter_id: recipientId,
        reported_id: requesterId,
        reason: reason ?? null,
        created_at: Date.now(),
      })
      .run();
  }
  return { ok: true };
}

/**
 * Backfills 'accepted' contacts rows from existing message history so
 * conversations that predate this feature keep working — without this,
 * shipping the message:send/call:invite gate would instantly lock every
 * chat that existed before the contacts table did. Safe to call on every
 * boot: onConflictDoNothing makes it a no-op past the first run.
 */
export function backfillAcceptedContactsFromMessages(): void {
  const pairs = db.select({ sender: messages.sender_id, recipient: messages.recipient_id }).from(messages).all();
  const seen = new Set<string>();
  for (const { sender, recipient } of pairs) {
    const [a, b] = canonicalPair(sender, recipient);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    db.insert(contacts)
      .values({
        id: randomUUID(),
        user_a_id: a,
        user_b_id: b,
        status: "accepted",
        requested_by: sender,
        created_at: Date.now(),
        responded_at: Date.now(),
      })
      .onConflictDoNothing({ target: [contacts.user_a_id, contacts.user_b_id] })
      .run();
  }
}
