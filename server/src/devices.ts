import { prisma } from "./prisma";

/**
 * Resolves the device a login belongs to. If the client already has a
 * persisted deviceId from a previous login on this same physical device,
 * reuse (and re-link, if it had been explicitly revoked) that row so its
 * identity carries forward. Otherwise — no deviceId sent, or one that
 * doesn't belong to this account — register a brand new device.
 */
export async function resolveLoginDevice(
  userId: string,
  publicKey: string,
  deviceId?: string,
  deviceName?: string
) {
  if (deviceId) {
    const existing = await prisma.device.findUnique({ where: { id: deviceId } });
    if (existing) {
      if (existing.userId === userId) {
        return prisma.device.update({
          where: { id: deviceId },
          data: { publicKey, name: deviceName ?? existing.name, lastSeenAt: new Date(), revokedAt: null },
        });
      }
      // Extraordinarily unlikely id collision with a device belonging to a
      // different account (client-generated ids are random UUIDs) — don't
      // reuse it, just register a fresh server-assigned one below.
      deviceId = undefined;
    }
  }

  // id: deviceId is either the client's own id (first login from a device
  // that hasn't logged in before) or undefined, in which case Prisma's
  // @default(uuid()) on Device.id takes over — passing an explicit
  // `undefined` for a defaulted field is treated as "field omitted".
  return prisma.device.create({
    data: { id: deviceId, userId, publicKey, name: deviceName ?? null, lastSeenAt: new Date() },
  });
}

export function listActiveDevices(userId: string) {
  return prisma.device.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: "desc" },
  });
}

// updateMany rather than update: a no-op if the device was deleted/purged
// in the moment between its socket disconnecting and this write landing,
// rather than throwing on a missing row for what's a best-effort timestamp.
export async function setDeviceLastSeen(deviceId: string, at: number): Promise<void> {
  await prisma.device.updateMany({ where: { id: deviceId }, data: { lastSeenAt: new Date(at) } });
}

export type RevokeDeviceResult = { ok: true } | { ok: false; error: "not_found" };

export async function revokeDevice(userId: string, deviceId: string): Promise<RevokeDeviceResult> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== userId || device.revokedAt) {
    return { ok: false, error: "not_found" };
  }

  await prisma.$transaction([
    prisma.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } }),
    prisma.session.updateMany({ where: { deviceId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  return { ok: true };
}
