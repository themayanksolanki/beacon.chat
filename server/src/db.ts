import Database from "better-sqlite3";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "beacon.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

export function initDatabase() {
  db.exec(`
    -- A user is identified by phone number. current_session_id holds the
    -- id of the one session allowed to be active at a time: logging in on
    -- a new device overwrites it, which immediately invalidates the old
    -- device's token (see requireAuth / socketServer session checks).
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      phone_number TEXT UNIQUE NOT NULL,
      public_key TEXT,
      current_session_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otp_challenges (
      id TEXT PRIMARY KEY NOT NULL,
      phone_number TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_otp_phone
      ON otp_challenges(phone_number, created_at);

    -- The server only ever stores ciphertext. It cannot read message
    -- content: encryption/decryption happens exclusively on-device using
    -- keys held in the device's secure storage.
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      read_at INTEGER,
      FOREIGN KEY (sender_id) REFERENCES users(id),
      FOREIGN KEY (recipient_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_recipient
      ON messages(recipient_id, delivered_at);
  `);

  // read_at was added after the messages table already shipped; guard the
  // migration for databases created before this column existed.
  const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "read_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN read_at INTEGER");
  }
}
