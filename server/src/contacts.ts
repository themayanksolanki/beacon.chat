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
 * chat that existed before the contacts table did.
 *
 * This is a one-time historical migration, not an ongoing job: every
 * message sent since the gate went live already required an accepted
 * contact row (see isAcceptedContact in socketServer.ts), so once this has
 * run successfully there is nothing left for it to backfill. Trigger it
 * explicitly (see index.ts) rather than on every boot.
 *
 * Grouped by (senderId, recipientId) so Postgres collapses duplicates
 * itself — this reads one row per distinct pair (bounded by conversation
 * count) instead of pulling every message row into memory — then writes
 * in small concurrent batches instead of one upsert per pair, sequentially.
 */
export async function backfillAcceptedContactsFromMessages(): Promise<void> {
  const pairs = await prisma.message.groupBy({ by: ["senderId", "recipientId"] });

  const canonicalPairs = new Map<string, { a: string; b: string; requestedBy: string }>();
  for (const { senderId, recipientId } of pairs) {
    const [a, b] = canonicalPair(senderId, recipientId);
    const key = `${a}:${b}`;
    if (!canonicalPairs.has(key)) canonicalPairs.set(key, { a, b, requestedBy: senderId });
  }

  const entries = [...canonicalPairs.values()];
  const BATCH_SIZE = 50;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(({ a, b, requestedBy }) =>
        prisma.contact.upsert({
          where: { userAId_userBId: { userAId: a, userBId: b } },
          update: {},
          create: { userAId: a, userBId: b, status: "accepted", requestedBy, respondedAt: new Date() },
        })
      )
    );
  }
}
