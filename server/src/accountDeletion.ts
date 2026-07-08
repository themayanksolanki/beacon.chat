import { and, eq, isNotNull, lte, or } from "drizzle-orm";
import { db } from "./db";
import { messages, reactions, users } from "./schema";
import { isMongoConnected, profiles } from "./mongo";

export const ACCOUNT_DELETION_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * Marks an account for deletion and immediately revokes its session (the
 * caller is expected to also disconnect any live socket — see
 * routes/auth.ts). The account and its data aren't actually removed until
 * purgeExpiredAccounts sweeps it up after the grace period.
 */
export function requestDeletion(userId: string): number {
  const requestedAt = Date.now();
  db.update(users)
    .set({ deletion_requested_at: requestedAt, current_session_id: null })
    .where(eq(users.id, userId))
    .run();
  return requestedAt + ACCOUNT_DELETION_GRACE_MS;
}

/** Called on every successful login — logging back in cancels a pending deletion. */
export function cancelDeletionIfPending(userId: string): void {
  db.update(users)
    .set({ deletion_requested_at: null })
    .where(eq(users.id, userId))
    .run();
}

/**
 * Permanently removes any account whose deletion grace period has elapsed:
 * its messages/reactions (in either direction), its Mongo profile doc, and
 * the user row itself. Meant to be run periodically (see
 * startAccountDeletionSweep) rather than called directly outside tests.
 */
export async function purgeExpiredAccounts(): Promise<void> {
  const cutoff = Date.now() - ACCOUNT_DELETION_GRACE_MS;
  const due = db
    .select({ id: users.id })
    .from(users)
    .where(and(isNotNull(users.deletion_requested_at), lte(users.deletion_requested_at, cutoff)))
    .all();

  for (const { id } of due) {
    db.delete(messages).where(or(eq(messages.sender_id, id), eq(messages.recipient_id, id))).run();
    db.delete(reactions).where(or(eq(reactions.sender_id, id), eq(reactions.recipient_id, id))).run();
    if (isMongoConnected()) {
      await profiles().deleteOne({ userId: id });
    }
    db.delete(users).where(eq(users.id, id)).run();
    console.log(`[accountDeletion] purged account ${id}`);
  }
}

export function startAccountDeletionSweep(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  purgeExpiredAccounts().catch((err) => console.error("[accountDeletion] sweep failed", err));
  return setInterval(() => {
    purgeExpiredAccounts().catch((err) => console.error("[accountDeletion] sweep failed", err));
  }, intervalMs);
}
