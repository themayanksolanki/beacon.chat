import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

// A user is identified by email. current_session_id holds the id of the one
// session allowed to be active at a time: logging in on a new device
// overwrites it, which immediately invalidates the old device's token (see
// requireAuth / socketServer session checks).
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  public_key: text("public_key"),
  current_session_id: text("current_session_id"),
  created_at: integer("created_at").notNull(),
  last_seen_at: integer("last_seen_at"),
  // Set when the user requests account deletion; cleared if they log back in
  // before the grace period elapses (see accountDeletion.ts). A background
  // sweep permanently purges any account whose deletion was requested more
  // than ACCOUNT_DELETION_GRACE_MS ago.
  deletion_requested_at: integer("deletion_requested_at"),
});

export const otpChallenges = sqliteTable(
  "otp_challenges",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    code_hash: text("code_hash").notNull(),
    expires_at: integer("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    created_at: integer("created_at").notNull(),
  },
  (table) => [index("idx_otp_email").on(table.email, table.created_at)]
);

// The server only ever stores ciphertext. It cannot read message content:
// encryption/decryption happens exclusively on-device using keys held in the
// device's secure storage.
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sender_id: text("sender_id")
      .notNull()
      .references(() => users.id),
    recipient_id: text("recipient_id")
      .notNull()
      .references(() => users.id),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    created_at: integer("created_at").notNull(),
    delivered_at: integer("delivered_at"),
    read_at: integer("read_at"),
  },
  (table) => [index("idx_messages_recipient").on(table.recipient_id, table.delivered_at)]
);

// One reaction per (message, reactor); ciphertext/nonce only, same as
// messages — the server never sees which emoji was used.
export const reactions = sqliteTable(
  "reactions",
  {
    message_id: text("message_id").notNull(),
    sender_id: text("sender_id").notNull(),
    recipient_id: text("recipient_id").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    created_at: integer("created_at").notNull(),
    delivered_at: integer("delivered_at"),
  },
  (table) => [
    primaryKey({ columns: [table.message_id, table.sender_id] }),
    index("idx_reactions_recipient").on(table.recipient_id, table.delivered_at),
  ]
);
