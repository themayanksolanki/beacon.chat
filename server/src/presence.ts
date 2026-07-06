import { db } from "./db";

interface UserRow {
  id: string;
  last_seen_at: number | null;
}

export function getLastSeen(userId: string): number | null {
  const user = db.prepare<[string], UserRow>("SELECT id, last_seen_at FROM users WHERE id = ?").get(userId);
  return user?.last_seen_at ?? null;
}

export function setLastSeen(userId: string, at: number): void {
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(at, userId);
}
