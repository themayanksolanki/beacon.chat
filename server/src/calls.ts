import { prisma } from "./prisma";

// Deliberately narrow — see the Call model's comment in schema.prisma.
// This only ever records the "callee had zero connected devices at
// call:invite time" case, not general call history (that stays local/
// per-device, same as before).

export async function recordMissedCall(input: {
  callId: string;
  callerId: string;
  calleeId: string;
  kind: "audio" | "video";
}): Promise<void> {
  await prisma.call.create({
    data: {
      callId: input.callId,
      callerId: input.callerId,
      calleeId: input.calleeId,
      kind: input.kind,
    },
  });
}

export interface MissedCallRow {
  call_id: string;
  caller_id: string;
  kind: "audio" | "video";
  created_at: number;
}

export async function getUnsyncedMissedCalls(calleeId: string): Promise<MissedCallRow[]> {
  const rows = await prisma.call.findMany({
    where: { calleeId, syncedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    call_id: row.callId,
    caller_id: row.callerId,
    kind: row.kind,
    created_at: row.createdAt.getTime(),
  }));
}

export async function markMissedCallsSynced(calleeId: string): Promise<void> {
  await prisma.call.updateMany({ where: { calleeId, syncedAt: null }, data: { syncedAt: new Date() } });
}
