import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";

export function getLastSeen(userId: string): number | null {
  const user = db
    .select({ id: users.id, last_seen_at: users.last_seen_at })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return user?.last_seen_at ?? null;
}

export function setLastSeen(userId: string, at: number): void {
  db.update(users).set({ last_seen_at: at }).where(eq(users.id, userId)).run();
}
