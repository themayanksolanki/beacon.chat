import { prisma } from "./prisma";

export async function getLastSeen(userId: string): Promise<number | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { lastSeenAt: true } });
  return user?.lastSeenAt?.getTime() ?? null;
}

export async function setLastSeen(userId: string, at: number): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(at) } });
}
