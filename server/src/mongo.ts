import { MongoClient, type Collection } from "mongodb";

const { MONGODB_URI } = process.env;

export interface ProfileDoc {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  updatedAt: number;
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
