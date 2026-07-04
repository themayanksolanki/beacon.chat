import Database from "better-sqlite3";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "beacon.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

export function initDatabase() {
  db.exec(`
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
  `);

  // read_at was added after the messages table already shipped; guard the
  // migration for databases created before this column existed.
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!messageColumns.some((c) => c.name === "read_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN read_at INTEGER");
  }

  // email replaces phone_number as the identity column; databases created
  // before this switch still have the old phone_number-keyed rows and
  // schema. phone_number was declared UNIQUE inline, and SQLite refuses to
  // DROP COLUMN on a column backing a UNIQUE constraint, so removing it
  // requires the classic rebuild-the-table dance rather than a plain ALTER.
  const userColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (userColumns.some((c) => c.name === "phone_number")) {
    db.exec(`
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

  const otpColumns = db.prepare("PRAGMA table_info(otp_challenges)").all() as { name: string }[];
  if (!otpColumns.some((c) => c.name === "email")) {
    db.exec("ALTER TABLE otp_challenges ADD COLUMN email TEXT");
  }
  if (otpColumns.some((c) => c.name === "phone_number")) {
    // The old phone_number index has to go before the column it indexes can.
    db.exec("DROP INDEX IF EXISTS idx_otp_phone");
    db.exec("ALTER TABLE otp_challenges DROP COLUMN phone_number");
  }

  // Created after the email column is guaranteed to exist (either from the
  // fresh CREATE TABLE above, or the migration just above this).
  db.exec("CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_challenges(email, created_at)");
}
