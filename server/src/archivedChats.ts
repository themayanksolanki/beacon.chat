import { prisma } from "./prisma";

export interface ArchivedChatEntry {
  peerId: string;
  archivedAt: Date;
}

/** Archives (or re-archives, bumping archivedAt) `peerId` for `userId` only — the other side's view is untouched. */
export async function archiveChat(userId: string, peerId: string): Promise<Date> {
  const row = await prisma.archivedChat.upsert({
    where: { userId_peerId: { userId, peerId } },
    update: { archivedAt: new Date() },
    create: { userId, peerId },
  });
  return row.archivedAt;
}

export async function unarchiveChat(userId: string, peerId: string): Promise<void> {
  await prisma.archivedChat.deleteMany({ where: { userId, peerId } });
}

/** Full current archive state for `userId` — used to seed/reconcile a device's local cache on connect (see flushArchivedChats in socketServer.ts). */
export async function listArchivedChats(userId: string): Promise<ArchivedChatEntry[]> {
  return prisma.archivedChat.findMany({
    where: { userId },
    select: { peerId: true, archivedAt: true },
  });
}
