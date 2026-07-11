import { prisma } from "./prisma";

export type ContactStatus = "pending" | "accepted" | "rejected";
export type RejectAction = "none" | "block" | "report";

// One row per relationship regardless of who acted first — sort the pair so
// (A requests B) and (B requests A) always land on the same row.
function canonicalPair(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

function getContactRow(idA: string, idB: string) {
  const [a, b] = canonicalPair(idA, idB);
  return prisma.contact.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } });
}

export async function isAcceptedContact(idA: string, idB: string): Promise<boolean> {
  const row = await getContactRow(idA, idB);
  return row?.status === "accepted";
}

export async function requestContact(
  requesterId: string,
  recipientId: string
): Promise<{ status: "pending" | "accepted" }> {
  const [a, b] = canonicalPair(requesterId, recipientId);
  const existing = await getContactRow(requesterId, recipientId);

  if (existing) {
    if (existing.status === "accepted") return { status: "accepted" };
    if (existing.status === "pending") {
      if (existing.requestedBy === requesterId) return { status: "pending" }; // idempotent re-request
      // The other side already requested us — mutual request, auto-accept.
      await prisma.contact.update({
        where: { userAId_userBId: { userAId: a, userBId: b } },
        data: { status: "accepted", respondedAt: new Date() },
      });
      return { status: "accepted" };
    }
    // status === 'rejected' -> fall through and overwrite with a fresh request.
  }

  await prisma.contact.upsert({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    update: { status: "pending", requestedBy: requesterId, createdAt: new Date(), respondedAt: null },
    create: { userAId: a, userBId: b, status: "pending", requestedBy: requesterId },
  });
  return { status: "pending" };
}

export type ContactActionResult = { ok: true } | { ok: false; error: "no_pending_request" };

export async function acceptContact(requesterId: string, recipientId: string): Promise<ContactActionResult> {
  const [a, b] = canonicalPair(requesterId, recipientId);
  const existing = await getContactRow(requesterId, recipientId);
  if (!existing || existing.status !== "pending" || existing.requestedBy !== requesterId) {
    return { ok: false, error: "no_pending_request" };
  }
  await prisma.contact.update({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    data: { status: "accepted", respondedAt: new Date() },
  });
  return { ok: true };
}

export async function rejectContact(
  requesterId: string,
  recipientId: string,
  action: RejectAction,
  reason?: string
): Promise<ContactActionResult> {
  const [a, b] = canonicalPair(requesterId, recipientId);
  const existing = await getContactRow(requesterId, recipientId);
  if (!existing || existing.status !== "pending" || existing.requestedBy !== requesterId) {
    return { ok: false, error: "no_pending_request" };
  }
  await prisma.contact.update({
    where: { userAId_userBId: { userAId: a, userBId: b } },
    data: { status: "rejected", respondedAt: new Date() },
  });

  if (action === "report") {
    await prisma.report.create({
      data: { reporterId: recipientId, reportedId: requesterId, reason: reason ?? null },
    });
  }
  return { ok: true };
}

/**
 * Backfills 'accepted' contacts rows from existing message history so
 * conversations that predate this feature keep working — without this,
 * shipping the message:send/call:invite gate would instantly lock every
 * chat that existed before the contacts table did. Safe to call on every
 * boot: the upsert's no-op update makes it a no-op past the first run.
 */
export async function backfillAcceptedContactsFromMessages(): Promise<void> {
  const pairs = await prisma.message.findMany({ select: { senderId: true, recipientId: true } });
  const seen = new Set<string>();
  for (const { senderId, recipientId } of pairs) {
    const [a, b] = canonicalPair(senderId, recipientId);
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await prisma.contact.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { userAId: a, userBId: b, status: "accepted", requestedBy: senderId, respondedAt: new Date() },
    });
  }
}
