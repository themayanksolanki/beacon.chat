import { Router } from "express";
import { requireAuth, type AuthedRequest } from "../auth";
import { listActiveDevices, revokeDevice } from "../devices";
import { revokeDeviceSessions } from "../socketServer";

export const devicesRouter = Router();

/** Lists the caller's linked devices — the "Linked Devices" Settings screen. */
devicesRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const devices = await listActiveDevices(req.user!.userId);

  res.json({
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt.getTime(),
      lastSeenAt: d.lastSeenAt?.getTime() ?? null,
      isCurrentDevice: d.id === req.user!.deviceId,
    })),
  });
});

/**
 * Unlinks a device: revokes it and every session it holds, then drops any
 * live socket connection it still has open. Works on any of the caller's
 * own devices, including the one making this very request (self-logout via
 * device removal, same as WhatsApp's "log out" on a linked device).
 */
devicesRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const deviceId = String(req.params.id);
  const result = await revokeDevice(req.user!.userId, deviceId);
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }

  await revokeDeviceSessions(deviceId);
  res.status(204).end();
});
