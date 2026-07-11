import { prisma } from "./prisma";
import { isMongoConnected, profiles } from "./mongo";
import { deleteAvatarObject } from "./s3";

export const ACCOUNT_DELETION_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * Marks an account for deletion and immediately revokes its sessions (the
 * caller is expected to also disconnect any live socket — see
 * routes/auth.ts). The account and its data aren't actually removed until
 * purgeExpiredAccounts sweeps it up after the grace period.
 */
export async function requestDeletion(userId: string): Promise<number> {
  const requestedAt = Date.now();
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date(requestedAt) } }),
    prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(requestedAt) } }),
  ]);
  return requestedAt + ACCOUNT_DELETION_GRACE_MS;
}

/** Called on every successful login — logging back in cancels a pending deletion. */
export async function cancelDeletionIfPending(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: null } });
}

/**
 * Permanently removes any account whose deletion grace period has elapsed:
 * its sessions/devices, messages/reactions (in either direction), contact
 * relationships, reports, its Mongo profile doc, and the user row itself.
 * Unlike the old SQLite database (which never had foreign keys turned on),
 * Postgres enforces them — so every table that references users.id has to
 * be cleared before the user row itself can go, in FK-dependency order.
 * Meant to be run periodically (see startAccountDeletionSweep) rather than
 * called directly outside tests.
 */
export async function purgeExpiredAccounts(): Promise<void> {
  const cutoff = new Date(Date.now() - ACCOUNT_DELETION_GRACE_MS);
  const due = await prisma.user.findMany({
    where: { deletionRequestedAt: { not: null, lte: cutoff } },
    select: { id: true },
  });

  for (const { id } of due) {
    // Sessions reference devices, so they have to go first.
    await prisma.session.deleteMany({ where: { userId: id } });
    // Messages/reactions reference this user's device(s) via
    // recipientDeviceId/senderDeviceId, so they have to clear before devices.
    await prisma.message.deleteMany({ where: { OR: [{ senderId: id }, { recipientId: id }] } });
    await prisma.reaction.deleteMany({ where: { OR: [{ senderId: id }, { recipientId: id }] } });
    await prisma.device.deleteMany({ where: { userId: id } });
    await prisma.contact.deleteMany({ where: { OR: [{ userAId: id }, { userBId: id }] } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: id }, { reportedId: id }] } });
    if (isMongoConnected()) {
      const profile = await profiles().findOneAndDelete({ userId: id });
      if (profile?.avatarKey) {
        void deleteAvatarObject(profile.avatarKey);
      }
    }
    await prisma.user.delete({ where: { id } });
    console.log(`[accountDeletion] purged account ${id}`);
  }
}

export function startAccountDeletionSweep(intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  purgeExpiredAccounts().catch((err) => console.error("[accountDeletion] sweep failed", err));
  return setInterval(() => {
    purgeExpiredAccounts().catch((err) => console.error("[accountDeletion] sweep failed", err));
  }, intervalMs);
}
