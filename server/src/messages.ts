import { prisma } from "./prisma";

// Wire format (and everything downstream in socketServer.ts) still speaks
// the old snake_case/epoch-ms shape from the SQLite days — Postgres/Prisma
// is an internal storage detail. `id` on the wire is the shared clientId,
// NOT the per-device row's own internal primary key — that's what lets the
// sender's single local outbox row (and its delivered/read receipts) stay
// keyed off one id even though one logical send now produces one row per
// recipient device server-side. `sender_public_key` is that device's own
// encryption key, attached here so the recipient can decrypt without
// maintaining a local cache of every peer device's key — it just trusts
// whatever key arrives on this specific message.
export interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  // The specific device this particular row/delivery is addressed to —
  // harmless to echo back to that same device (it's just being told its own
  // id), and lets socketServer.ts route each row to the right device room
  // without a separate parallel data structure.
  recipient_device_id: string;
  ciphertext: string;
  nonce: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
  sender_public_key: string | null;
}

function toMessageRow(
  m: {
    clientId: string;
    senderId: string;
    recipientId: string;
    recipientDeviceId: string;
    ciphertext: string;
    nonce: string;
    createdAt: Date;
    deliveredAt: Date | null;
    readAt: Date | null;
  },
  senderPublicKey: string | null
): MessageRow {
  return {
    id: m.clientId,
    sender_id: m.senderId,
    recipient_id: m.recipientId,
    recipient_device_id: m.recipientDeviceId,
    ciphertext: m.ciphertext,
    nonce: m.nonce,
    created_at: m.createdAt.getTime(),
    delivered_at: m.deliveredAt?.getTime() ?? null,
    read_at: m.readAt?.getTime() ?? null,
    sender_public_key: senderPublicKey,
  };
}

async function resolveDevicePublicKeys(deviceIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(deviceIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const devices = await prisma.device.findMany({ where: { id: { in: ids } }, select: { id: true, publicKey: true } });
  return new Map(devices.map((d) => [d.id, d.publicKey]));
}

export async function userExists(id: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  return !!user;
}

// deviceId (not recipientDeviceId) to match the wire convention used
// elsewhere, e.g. GET /users/by-id/:id's devices: [{deviceId, publicKey}] —
// this is what the client actually sends as part of message:send's payload.
export interface OutgoingEnvelope {
  deviceId: string;
  ciphertext: string;
  nonce: string;
}

/**
 * One logical send, encrypted client-side once per active recipient
 * device, becomes one Message row per envelope here — all sharing
 * `clientId` so delivery/read receipts and delete-for-everyone can treat
 * them as a single message again. Envelopes addressed to a device that
 * isn't currently active (revoked, or a stale id the client cached before a
 * removal) are silently dropped rather than erroring — that's a normal
 * race between "the client fetched the device list" and "now", not a bug.
 * Returns an empty array if none of the envelopes had a valid target.
 */
export async function storeMessages(input: {
  clientId: string;
  senderId: string;
  senderDeviceId: string | null;
  recipientId: string;
  envelopes: OutgoingEnvelope[];
}): Promise<MessageRow[]> {
  const activeDevices = await prisma.device.findMany({
    where: { userId: input.recipientId, revokedAt: null },
    select: { id: true },
  });
  const activeDeviceIds = new Set(activeDevices.map((d) => d.id));
  const validEnvelopes = input.envelopes.filter((e) => activeDeviceIds.has(e.deviceId));
  if (validEnvelopes.length === 0) return [];

  const senderPublicKey = (await resolveDevicePublicKeys([input.senderDeviceId])).get(input.senderDeviceId ?? "") ?? null;

  const rows = await prisma.$transaction(
    validEnvelopes.map((envelope) =>
      prisma.message.create({
        data: {
          clientId: input.clientId,
          senderId: input.senderId,
          senderDeviceId: input.senderDeviceId,
          recipientId: input.recipientId,
          recipientDeviceId: envelope.deviceId,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
        },
      })
    )
  );

  return rows.map((row) => toMessageRow(row, senderPublicKey));
}

export async function getUndeliveredMessages(deviceId: string): Promise<MessageRow[]> {
  const rows = await prisma.message.findMany({
    where: { recipientDeviceId: deviceId, deliveredAt: null },
    orderBy: { createdAt: "asc" },
  });
  const publicKeys = await resolveDevicePublicKeys(rows.map((r) => r.senderDeviceId));
  return rows.map((row) => toMessageRow(row, publicKeys.get(row.senderDeviceId ?? "") ?? null));
}

export type MarkResult =
  | { ok: true; senderId: string; at: number }
  | { ok: false; error: "not_found" | "not_recipient" };

/**
 * requesterId must be the authenticated socket's own userId, not a
 * client-supplied value — otherwise any user could mark someone else's
 * message delivered/read and spoof a receipt to an arbitrary room. Looked
 * up by (clientId, requesterDeviceId) since each recipient device acks its
 * own copy independently; the sender to notify is read back from the row
 * rather than trusted from the client for the same reason.
 *
 * isSenderOnline is the caller's (socketServer.ts) way of checking whether
 * the sender has a live socket right now — it's a callback rather than a
 * plain boolean because the sender's id isn't known until after the lookup
 * below. The live io.to(senderId).emit(...) that follows this call is a
 * silent no-op if the sender isn't connected, so deliveredSyncedAt/
 * readSyncedAt are only set when there's an actual socket to have received
 * it; left null otherwise so flushMessageStatus can find and re-emit it once
 * the sender reconnects instead of the receipt being lost for good.
 */
export async function markDelivered(
  clientId: string,
  requesterDeviceId: string,
  requesterId: string,
  isSenderOnline: (senderId: string) => boolean
): Promise<MarkResult> {
  const message = await prisma.message.findFirst({ where: { clientId, recipientDeviceId: requesterDeviceId } });
  if (!message) return { ok: false, error: "not_found" };
  if (message.recipientId !== requesterId) return { ok: false, error: "not_recipient" };

  const deliveredAt = new Date();
  const senderOnline = isSenderOnline(message.senderId);
  await prisma.message.update({
    where: { id: message.id },
    data: { deliveredAt, deliveredSyncedAt: senderOnline ? deliveredAt : null },
  });
  return { ok: true, senderId: message.senderId, at: deliveredAt.getTime() };
}

export async function markRead(
  clientId: string,
  requesterDeviceId: string,
  requesterId: string,
  isSenderOnline: (senderId: string) => boolean
): Promise<MarkResult> {
  const message = await prisma.message.findFirst({ where: { clientId, recipientDeviceId: requesterDeviceId } });
  if (!message) return { ok: false, error: "not_found" };
  if (message.recipientId !== requesterId) return { ok: false, error: "not_recipient" };

  const readAt = new Date();
  const senderOnline = isSenderOnline(message.senderId);
  await prisma.message.update({
    where: { id: message.id },
    data: {
      readAt,
      readSyncedAt: senderOnline ? readAt : null,
      // A read receipt implies delivery — set/sync deliveredAt too so
      // flushMessageStatus doesn't separately (and redundantly) re-emit a
      // stale "delivered" event after the sender already has "read".
      // Preserve deliveredSyncedAt if it was already set by an earlier,
      // successfully-synced delivered receipt.
      deliveredAt: message.deliveredAt ?? readAt,
      deliveredSyncedAt: message.deliveredSyncedAt ?? (senderOnline ? readAt : null),
    },
  });
  return { ok: true, senderId: message.senderId, at: readAt.getTime() };
}

export interface MessageStatusUpdate {
  id: string;
  deliveredAt: number | null;
  readAt: number | null;
}

/**
 * Delivery/read receipts a sender missed while offline (mirrors
 * getUndeliveredMessages, but for the receipt going back to the sender
 * rather than the message going to the recipient) — see markDelivered/
 * markRead above for how deliveredSyncedAt/readSyncedAt get set.
 */
export async function getUnsyncedMessageStatus(senderId: string): Promise<MessageStatusUpdate[]> {
  const rows = await prisma.message.findMany({
    where: {
      senderId,
      OR: [
        { deliveredAt: { not: null }, deliveredSyncedAt: null },
        { readAt: { not: null }, readSyncedAt: null },
      ],
    },
    select: { clientId: true, deliveredAt: true, readAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.clientId,
    deliveredAt: row.deliveredAt?.getTime() ?? null,
    readAt: row.readAt?.getTime() ?? null,
  }));
}

export async function markMessageStatusSynced(senderId: string): Promise<void> {
  const now = new Date();
  await prisma.message.updateMany({
    where: { senderId, deliveredAt: { not: null }, deliveredSyncedAt: null },
    data: { deliveredSyncedAt: now },
  });
  await prisma.message.updateMany({
    where: { senderId, readAt: { not: null }, readSyncedAt: null },
    data: { readSyncedAt: now },
  });
}

export const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 60 * 60 * 1000;

export type DeleteForEveryoneResult =
  | { ok: true; message: MessageRow }
  | { ok: false; error: "not_found" | "not_sender" | "too_late" };

/**
 * Only the original sender can delete for everyone, and only within the
 * time window — enforced here since the client's own check is just UX, not
 * a security boundary. Deletes every per-device fan-out row sharing this
 * clientId in one go.
 */
export async function deleteMessageForEveryone(clientId: string, requesterId: string): Promise<DeleteForEveryoneResult> {
  const rows = await prisma.message.findMany({ where: { clientId } });
  if (rows.length === 0) return { ok: false, error: "not_found" };
  const [first] = rows;
  if (first.senderId !== requesterId) return { ok: false, error: "not_sender" };
  if (Date.now() - first.createdAt.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS) {
    return { ok: false, error: "too_late" };
  }

  await prisma.message.deleteMany({ where: { clientId } });
  return { ok: true, message: toMessageRow(first, null) };
}

export interface ReactionRow {
  message_id: string;
  sender_id: string;
  recipient_id: string;
  recipient_device_id: string;
  ciphertext: string;
  nonce: string;
  created_at: number;
  delivered_at: number | null;
  sender_public_key: string | null;
}

function toReactionRow(
  r: {
    messageId: string;
    senderId: string;
    recipientId: string;
    recipientDeviceId: string;
    ciphertext: string;
    nonce: string;
    createdAt: Date;
    deliveredAt: Date | null;
  },
  senderPublicKey: string | null
): ReactionRow {
  return {
    message_id: r.messageId,
    sender_id: r.senderId,
    recipient_id: r.recipientId,
    recipient_device_id: r.recipientDeviceId,
    ciphertext: r.ciphertext,
    nonce: r.nonce,
    created_at: r.createdAt.getTime(),
    delivered_at: r.deliveredAt?.getTime() ?? null,
    sender_public_key: senderPublicKey,
  };
}

/**
 * One reaction per (message, reactor, recipient device) — reacting again
 * just overwrites the previous emoji for that device. Fanned out to every
 * active recipient device the same way storeMessages fans out messages, for
 * the same reason: without this, a reaction fetched by whichever device
 * happens to come online first gets marked delivered and a second linked
 * device never sees it. Envelopes addressed to a device that isn't
 * currently active are silently dropped, same as storeMessages. Returns an
 * empty array if none of the envelopes had a valid target.
 */
export async function setReactions(input: {
  messageId: string;
  senderId: string;
  senderDeviceId: string | null;
  recipientId: string;
  envelopes: OutgoingEnvelope[];
}): Promise<ReactionRow[]> {
  const activeDevices = await prisma.device.findMany({
    where: { userId: input.recipientId, revokedAt: null },
    select: { id: true },
  });
  const activeDeviceIds = new Set(activeDevices.map((d) => d.id));
  const validEnvelopes = input.envelopes.filter((e) => activeDeviceIds.has(e.deviceId));
  if (validEnvelopes.length === 0) return [];

  const senderPublicKey = (await resolveDevicePublicKeys([input.senderDeviceId])).get(input.senderDeviceId ?? "") ?? null;

  const rows = await prisma.$transaction(
    validEnvelopes.map((envelope) =>
      prisma.reaction.upsert({
        where: {
          messageId_senderId_recipientDeviceId: {
            messageId: input.messageId,
            senderId: input.senderId,
            recipientDeviceId: envelope.deviceId,
          },
        },
        update: {
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
          senderDeviceId: input.senderDeviceId,
          createdAt: new Date(),
          deliveredAt: null,
        },
        create: {
          messageId: input.messageId,
          senderId: input.senderId,
          senderDeviceId: input.senderDeviceId,
          recipientId: input.recipientId,
          recipientDeviceId: envelope.deviceId,
          ciphertext: envelope.ciphertext,
          nonce: envelope.nonce,
        },
      })
    )
  );

  return rows.map((row) => toReactionRow(row, senderPublicKey));
}

export async function clearReaction(messageId: string, senderId: string): Promise<void> {
  await prisma.reaction.deleteMany({ where: { messageId, senderId } });
}

export async function getUndeliveredReactions(deviceId: string): Promise<ReactionRow[]> {
  const rows = await prisma.reaction.findMany({
    where: { recipientDeviceId: deviceId, deliveredAt: null },
    orderBy: { createdAt: "asc" },
  });
  const publicKeys = await resolveDevicePublicKeys(rows.map((r) => r.senderDeviceId));
  return rows.map((row) => toReactionRow(row, publicKeys.get(row.senderDeviceId ?? "") ?? null));
}

export async function markReactionDelivered(messageId: string, senderId: string, recipientDeviceId: string): Promise<void> {
  await prisma.reaction.updateMany({
    where: { messageId, senderId, recipientDeviceId },
    data: { deliveredAt: new Date() },
  });
}
