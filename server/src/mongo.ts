import { MongoClient, type Collection } from "mongodb";
import { publicAvatarUrl } from "./s3";

const { MONGODB_URI } = process.env;

export interface ProfileDoc {
  userId: string;
  email: string;
  name: string;
  // S3 object key for the avatar (new uploads). Preferred over avatarUrl.
  avatarKey: string | null;
  // Legacy: base64 data: URL embedded directly in the doc. Read-only —
  // no longer written by new profile updates, kept so existing docs from
  // before the S3 migration keep rendering without a backfill.
  avatarUrl: string | null;
  updatedAt: number;
}

/** Resolves the avatar URL to serve to clients: prefer the S3-backed key,
 * falling back to a legacy embedded base64 avatarUrl for pre-migration docs. */
export function resolveAvatarUrl(doc: Pick<ProfileDoc, "avatarKey" | "avatarUrl">): string | null {
  if (doc.avatarKey) return publicAvatarUrl(doc.avatarKey);
  return doc.avatarUrl ?? null;
}

let client: MongoClient | null = null;

/** Profile data (name, avatar) lives in Mongo; auth/identity stays in SQLite (see db.ts). */
export async function connectMongo(): Promise<void> {
  if (!MONGODB_URI) {
    console.log("[mongo] MONGODB_URI not set, profile sync disabled");
    return;
  }
  const connecting = new MongoClient(MONGODB_URI);
  await connecting.connect();
  client = connecting;
  await profiles().createIndex({ userId: 1 }, { unique: true });
}

export function isMongoConnected(): boolean {
  return client !== null;
}

export function profiles(): Collection<ProfileDoc> {
  if (!client) {
    throw new Error("mongo_not_connected");
  }
  return client.db("beacon").collection<ProfileDoc>("profiles");
}
