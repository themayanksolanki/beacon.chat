import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "beacon.db");

export const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

export function initDatabase() {
  sqlite.exec(`
    -- A user is identified by email. current_session_id holds the id of
    -- the one session allowed to be active at a time: logging in on a new
    -- device overwrites it, which immediately invalidates the old device's
    -- token (see requireAuth / socketServer session checks).
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT UNIQUE NOT NULL,
      public_key TEXT,
      current_session_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS otp_challenges (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

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

    -- One reaction per (message, reactor); ciphertext/nonce only, same as
    -- messages — the server never sees which emoji was used.
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      PRIMARY KEY (message_id, sender_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reactions_recipient
      ON reactions(recipient_id, delivered_at);

    -- Gates message:send/reaction:set/call:invite: two users may only
    -- exchange messages or calls once their row here is 'accepted'. One row
    -- per pair, canonically ordered (user_a_id < user_b_id) — see contacts.ts.
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY NOT NULL,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
      requested_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      responded_at INTEGER,
      FOREIGN KEY (user_a_id) REFERENCES users(id),
      FOREIGN KEY (user_b_id) REFERENCES users(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_pair ON contacts(user_a_id, user_b_id);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY NOT NULL,
      reporter_id TEXT NOT NULL,
      reported_id TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (reporter_id) REFERENCES users(id),
      FOREIGN KEY (reported_id) REFERENCES users(id)
    );
  `);

  // read_at was added after the messages table already shipped; guard the
  // migration for databases created before this column existed.
  const messageColumns = sqlite.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!messageColumns.some((c) => c.name === "read_at")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN read_at INTEGER");
  }

  // email replaces phone_number as the identity column; databases created
  // before this switch still have the old phone_number-keyed rows and
  // schema. phone_number was declared UNIQUE inline, and SQLite refuses to
  // DROP COLUMN on a column backing a UNIQUE constraint, so removing it
  // requires the classic rebuild-the-table dance rather than a plain ALTER.
  const userColumns = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (userColumns.some((c) => c.name === "phone_number")) {
    sqlite.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY NOT NULL,
        email TEXT UNIQUE NOT NULL DEFAULT '',
        public_key TEXT,
        current_session_id TEXT,
        created_at INTEGER NOT NULL
      );

      INSERT INTO users_new (id, email, public_key, current_session_id, created_at)
        SELECT id, COALESCE(email, phone_number), public_key, current_session_id, created_at FROM users;

      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  }

  // Presence: last_seen_at is set when a user's final socket disconnects.
  const currentUserColumns = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!currentUserColumns.some((c) => c.name === "last_seen_at")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN last_seen_at INTEGER");
  }
  if (!currentUserColumns.some((c) => c.name === "deletion_requested_at")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER");
  }

  const userColumnsForPhone = sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!userColumnsForPhone.some((c) => c.name === "contact_number")) {
    sqlite.exec("ALTER TABLE users ADD COLUMN contact_number TEXT");
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_contact_number ON users(contact_number)");

  const otpColumns = sqlite.prepare("PRAGMA table_info(otp_challenges)").all() as { name: string }[];
  if (!otpColumns.some((c) => c.name === "email")) {
    sqlite.exec("ALTER TABLE otp_challenges ADD COLUMN email TEXT");
  }
  if (otpColumns.some((c) => c.name === "phone_number")) {
    // The old phone_number index has to go before the column it indexes can.
    sqlite.exec("DROP INDEX IF EXISTS idx_otp_phone");
    sqlite.exec("ALTER TABLE otp_challenges DROP COLUMN phone_number");
  }

  // Created after the email column is guaranteed to exist (either from the
  // fresh CREATE TABLE above, or the migration just above this).
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_challenges(email, created_at)");

  // Emails are now normalized (trim + lowercase) at every write, but rows
  // created before that fix may still hold mixed-case addresses — those
  // silently failed to match the case-sensitive lookups used by the
  // add-contact search (see routes/users.ts). Backfill them once; a
  // per-row update (rather than one bulk UPDATE) means a leftover
  // collision between two differently-cased rows for what's really the
  // same address just gets logged and skipped instead of aborting the
  // whole migration.
  const usersToNormalize = sqlite
    .prepare("SELECT id, email FROM users")
    .all() as { id: string; email: string }[];
  const updateUserEmail = sqlite.prepare("UPDATE users SET email = ? WHERE id = ?");
  for (const row of usersToNormalize) {
    const normalized = row.email.trim().toLowerCase();
    if (normalized === row.email) continue;
    try {
      updateUserEmail.run(normalized, row.id);
    } catch (err) {
      console.error(`[migration] couldn't normalize email casing for user ${row.id}:`, err);
    }
  }
}
