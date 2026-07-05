import * as SQLite from "expo-sqlite";

const db = SQLite.openDatabaseSync("beacon.db");

export function initDatabase() {
  db.execSync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      peer_public_key TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
      plaintext TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      delivered_at INTEGER,
      read_at INTEGER,
      reply_to_id TEXT,
      reply_preview TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, sent_at);
  `);

  // status/delivered_at/read_at/reply_* were added after this table already
  // shipped to earlier test installs — guard the migration for dbs created
  // before these columns existed.
  const existingColumns = new Set(
    db.getAllSync<{ name: string }>(`PRAGMA table_info(messages)`).map((c) => c.name)
  );
  const migrations: [string, string][] = [
    ["status", "ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'"],
    ["delivered_at", "ALTER TABLE messages ADD COLUMN delivered_at INTEGER"],
    ["read_at", "ALTER TABLE messages ADD COLUMN read_at INTEGER"],
    ["reply_to_id", "ALTER TABLE messages ADD COLUMN reply_to_id TEXT"],
    ["reply_preview", "ALTER TABLE messages ADD COLUMN reply_preview TEXT"],
    ["pinned_at", "ALTER TABLE messages ADD COLUMN pinned_at INTEGER"],
    ["deleted_at", "ALTER TABLE messages ADD COLUMN deleted_at INTEGER"],
  ];
  for (const [column, statement] of migrations) {
    if (!existingColumns.has(column)) {
      db.execSync(statement);
    }
  }
}

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: "outgoing" | "incoming";
  plaintext: string;
  sent_at: number;
  status: MessageStatus;
  delivered_at: number | null;
  read_at: number | null;
  reply_to_id: string | null;
  reply_preview: string | null;
  pinned_at: number | null;
  deleted_at: number | null;
}

export function insertMessage(message: MessageRow) {
  db.runSync(
    `INSERT INTO messages
       (id, conversation_id, direction, plaintext, sent_at, status, delivered_at, read_at, reply_to_id, reply_preview, pinned_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.conversation_id,
      message.direction,
      message.plaintext,
      message.sent_at,
      message.status,
      message.delivered_at,
      message.read_at,
      message.reply_to_id,
      message.reply_preview,
      message.pinned_at,
      message.deleted_at,
    ]
  );
}

export function getMessages(conversationId: string): MessageRow[] {
  return db.getAllSync<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC`,
    [conversationId]
  );
}

export function getUnreadIncomingMessages(conversationId: string): MessageRow[] {
  return db.getAllSync<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? AND direction = 'incoming' AND read_at IS NULL`,
    [conversationId]
  );
}

export function markMessageSent(id: string): void {
  db.runSync(`UPDATE messages SET status = 'sent' WHERE id = ? AND status = 'pending'`, [id]);
}

export function markMessageFailed(id: string): void {
  db.runSync(`UPDATE messages SET status = 'failed' WHERE id = ? AND status = 'pending'`, [id]);
}

export function markMessagePending(id: string): void {
  db.runSync(`UPDATE messages SET status = 'pending' WHERE id = ? AND status = 'failed'`, [id]);
}

export function markMessageDelivered(id: string, deliveredAt: number): void {
  db.runSync(
    `UPDATE messages SET status = 'delivered', delivered_at = ?
     WHERE id = ? AND status IN ('pending', 'sent')`,
    [deliveredAt, id]
  );
}

export function markMessageRead(id: string, readAt: number): void {
  db.runSync(`UPDATE messages SET status = 'read', read_at = ? WHERE id = ?`, [readAt, id]);
}

export function deleteMessage(id: string): void {
  db.runSync(`DELETE FROM messages WHERE id = ?`, [id]);
}

// Only one message pinned per conversation at a time — pinning a new one
// replaces the last.
export function pinMessage(conversationId: string, id: string): void {
  db.withTransactionSync(() => {
    db.runSync(`UPDATE messages SET pinned_at = NULL WHERE conversation_id = ?`, [conversationId]);
    db.runSync(`UPDATE messages SET pinned_at = ? WHERE id = ?`, [Date.now(), id]);
  });
}

export function unpinMessage(id: string): void {
  db.runSync(`UPDATE messages SET pinned_at = NULL WHERE id = ?`, [id]);
}

export function getPinnedMessage(conversationId: string): MessageRow | null {
  return db.getFirstSync<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC LIMIT 1`,
    [conversationId]
  );
}

// Tombstones the message (clears its plaintext) rather than removing the
// row, so both sides render a "message deleted" placeholder in its place.
export function markMessageDeletedEverywhere(id: string, deletedAt: number): void {
  db.runSync(
    `UPDATE messages SET deleted_at = ?, plaintext = '', reply_preview = NULL, pinned_at = NULL WHERE id = ?`,
    [deletedAt, id]
  );
}

export interface ConversationRow {
  id: string;
  peer_public_key: string;
  display_name: string | null;
  created_at: number;
}

export function getConversations(): ConversationRow[] {
  return db.getAllSync<ConversationRow>(`SELECT * FROM conversations ORDER BY created_at DESC`);
}

export interface ConversationSummary extends ConversationRow {
  last_message: string | null;
  last_message_at: number | null;
  unread_count: number;
}

export function getConversationSummaries(): ConversationSummary[] {
  return db.getAllSync<ConversationSummary>(`
    SELECT
      c.*,
      (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN 'This message was deleted' ELSE m.plaintext END
         FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message,
      (SELECT sent_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'incoming' AND m.read_at IS NULL) AS unread_count
    FROM conversations c
    ORDER BY COALESCE(last_message_at, c.created_at) DESC
  `);
}

export function getConversationByPeerKey(peerPublicKey: string): ConversationRow | null {
  return db.getFirstSync<ConversationRow>(
    `SELECT * FROM conversations WHERE peer_public_key = ?`,
    [peerPublicKey]
  );
}

export function getConversationById(id: string): ConversationRow | null {
  return db.getFirstSync<ConversationRow>(`SELECT * FROM conversations WHERE id = ?`, [id]);
}

export function insertConversation(conversation: ConversationRow): void {
  db.runSync(
    `INSERT INTO conversations (id, peer_public_key, display_name, created_at) VALUES (?, ?, ?, ?)`,
    [conversation.id, conversation.peer_public_key, conversation.display_name, conversation.created_at]
  );
}

export default db;
