import * as SQLite from "expo-sqlite";
import { sanitizeAccountKey } from "../storage/accountKey";

let currentAccountKey = "";
let db = SQLite.openDatabaseSync("beacon.db");

// Each signed-in account gets its own local database file. Without this,
// conversations/messages/calls/blocked_users persisted under one account
// would still be sitting in the shared db file and would show up as-is for
// the next account that signs into this device.
export function initDatabase(accountKey: string) {
  const key = sanitizeAccountKey(accountKey);
  if (key !== currentAccountKey) {
    db.closeSync();
    db = SQLite.openDatabaseSync(`beacon-${key}.db`);
    currentAccountKey = key;
  }

  runMigrations();
}

// Used when an account is deleted (as opposed to a plain logout, which
// leaves the local db in place so the same account's history is there if
// the user signs back in) — permanently removes this account's local
// conversations/messages/calls/blocked_users from the device.
export function wipeAccountDatabase(accountKey: string) {
  const key = sanitizeAccountKey(accountKey);
  if (key === currentAccountKey) {
    db.closeSync();
    currentAccountKey = "";
    db = SQLite.openDatabaseSync("beacon.db");
  }
  try {
    SQLite.deleteDatabaseSync(`beacon-${key}.db`);
  } catch {
    // Nothing to delete (e.g. account was deleted before ever opening a chat).
  }
}

function runMigrations() {
  db.execSync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY NOT NULL,
      peer_public_key TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
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

    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
      kind TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
      status TEXT NOT NULL CHECK (status IN ('completed', 'missed', 'declined', 'failed')),
      started_at INTEGER NOT NULL,
      answered_at INTEGER,
      ended_at INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at);

    CREATE TABLE IF NOT EXISTS blocked_users (
      peer_id TEXT PRIMARY KEY NOT NULL,
      blocked_at INTEGER NOT NULL
    );

    -- A peer's currently-active linked devices, each with its own
    -- encryption key — real multi-device fan-out needs one ciphertext per
    -- device, not one per peer (see conversations.peer_public_key above,
    -- which is now only a fallback for before this cache is first
    -- populated). Refreshed wholesale (see replacePeerDevices) at the same
    -- points peer_public_key refreshes today: on chat open, and on a
    -- decrypt-retry.
    CREATE TABLE IF NOT EXISTS peer_devices (
      conversation_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      PRIMARY KEY (conversation_id, device_id)
    );
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
    ["reaction_mine", "ALTER TABLE messages ADD COLUMN reaction_mine TEXT"],
    ["reaction_peer", "ALTER TABLE messages ADD COLUMN reaction_peer TEXT"],
    ["kind", "ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'"],
    ["audio_uri", "ALTER TABLE messages ADD COLUMN audio_uri TEXT"],
    ["duration_ms", "ALTER TABLE messages ADD COLUMN duration_ms INTEGER"],
    ["waveform", "ALTER TABLE messages ADD COLUMN waveform TEXT"],
    ["image_uri", "ALTER TABLE messages ADD COLUMN image_uri TEXT"],
    ["image_width", "ALTER TABLE messages ADD COLUMN image_width INTEGER"],
    ["image_height", "ALTER TABLE messages ADD COLUMN image_height INTEGER"],
    // Unlike image_uri (a local file path), gif_url is a remote GIPHY CDN
    // URL — GIFs aren't downloaded/persisted locally, just referenced.
    ["gif_url", "ALTER TABLE messages ADD COLUMN gif_url TEXT"],
    ["gif_width", "ALTER TABLE messages ADD COLUMN gif_width INTEGER"],
    ["gif_height", "ALTER TABLE messages ADD COLUMN gif_height INTEGER"],
    ["video_uri", "ALTER TABLE messages ADD COLUMN video_uri TEXT"],
    ["video_width", "ALTER TABLE messages ADD COLUMN video_width INTEGER"],
    ["video_height", "ALTER TABLE messages ADD COLUMN video_height INTEGER"],
    ["video_duration_ms", "ALTER TABLE messages ADD COLUMN video_duration_ms INTEGER"],
    ["video_size", "ALTER TABLE messages ADD COLUMN video_size INTEGER"],
    ["file_uri", "ALTER TABLE messages ADD COLUMN file_uri TEXT"],
    ["file_name", "ALTER TABLE messages ADD COLUMN file_name TEXT"],
    ["file_mime", "ALTER TABLE messages ADD COLUMN file_mime TEXT"],
    ["file_size", "ALTER TABLE messages ADD COLUMN file_size INTEGER"],
    // media_url/key/nonce are shared across S3-backed kinds (image when sent
    // via the new attachment pipeline, video, file) rather than duplicated
    // per-kind — one generic "remote encrypted media" tracking set. key/nonce
    // are the file's crypto_secretbox symmetric key (see crypto/fileCrypto.ts)
    // and are only ever stored locally on-device, never sent back to the
    // server — same local-plaintext trust model as plaintext/waveform today.
    ["media_url", "ALTER TABLE messages ADD COLUMN media_url TEXT"],
    ["media_key", "ALTER TABLE messages ADD COLUMN media_key TEXT"],
    ["media_nonce", "ALTER TABLE messages ADD COLUMN media_nonce TEXT"],
    ["media_status", "ALTER TABLE messages ADD COLUMN media_status TEXT NOT NULL DEFAULT 'ready'"],
  ];
  for (const [column, statement] of migrations) {
    if (!existingColumns.has(column)) {
      db.execSync(statement);
    }
  }

  // avatar_url/status were added after this table already shipped to earlier
  // test installs — same guard as above, for conversations instead of
  // messages. status defaults to 'accepted' so every pre-existing
  // conversation keeps working unchanged (mirrors the server-side backfill
  // in contacts.ts).
  const existingConversationColumns = new Set(
    db.getAllSync<{ name: string }>(`PRAGMA table_info(conversations)`).map((c) => c.name)
  );
  if (!existingConversationColumns.has("avatar_url")) {
    db.execSync(`ALTER TABLE conversations ADD COLUMN avatar_url TEXT`);
  }
  if (!existingConversationColumns.has("status")) {
    db.execSync(`ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'`);
  }
  // Peer's self-reported contact number, synced from the server (see
  // updateConversationProfile) — same "cached once, refreshed on open" story
  // as display_name/avatar_url above.
  if (!existingConversationColumns.has("contact_number")) {
    db.execSync(`ALTER TABLE conversations ADD COLUMN contact_number TEXT`);
  }
}

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";
export type MessageKind = "text" | "voice" | "image" | "gif" | "video" | "file";

// Tracks an S3-backed attachment's transfer state (image sent via the new
// attachment pipeline, video, file). 'ready' is also the default/no-op value
// for kinds that never touch S3 (text/voice/gif, and legacy inline images).
export type MediaStatus =
  | "ready"
  | "uploading"
  | "upload_failed"
  | "downloading"
  | "download_failed"
  | "idle";

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
  reaction_mine: string | null;
  reaction_peer: string | null;
  kind: MessageKind;
  /** Local file uri for the decrypted/recorded audio clip. Only set when kind === 'voice'. */
  audio_uri: string | null;
  duration_ms: number | null;
  /** JSON-encoded array of 0..1 amplitude samples. Only set when kind === 'voice'. */
  waveform: string | null;
  /** Local file uri for the decrypted/compressed image. Only set when kind === 'image'. */
  image_uri: string | null;
  image_width: number | null;
  image_height: number | null;
  /** Remote GIPHY CDN url — not a local file, unlike image_uri. Only set when kind === 'gif'. */
  gif_url: string | null;
  gif_width: number | null;
  gif_height: number | null;
  /** Local file uri for the decrypted video. Only set when kind === 'video'. */
  video_uri: string | null;
  video_width: number | null;
  video_height: number | null;
  video_duration_ms: number | null;
  video_size: number | null;
  /** Local file uri for the decrypted generic attachment. Only set when kind === 'file'. */
  file_uri: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  /** S3 object url + symmetric decryption key/nonce for an S3-backed
   * attachment (image sent via the attachment pipeline, video, file).
   * Null for text/voice/gif and for legacy inline-base64 images. */
  media_url: string | null;
  media_key: string | null;
  media_nonce: string | null;
  media_status: MediaStatus;
}

export function insertMessage(message: MessageRow) {
  db.runSync(
    `INSERT INTO messages
       (id, conversation_id, direction, plaintext, sent_at, status, delivered_at, read_at, reply_to_id, reply_preview, pinned_at, deleted_at, reaction_mine, reaction_peer, kind, audio_uri, duration_ms, waveform, image_uri, image_width, image_height, gif_url, gif_width, gif_height, video_uri, video_width, video_height, video_duration_ms, video_size, file_uri, file_name, file_mime, file_size, media_url, media_key, media_nonce, media_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      message.reaction_mine,
      message.reaction_peer,
      message.kind,
      message.audio_uri,
      message.duration_ms,
      message.waveform,
      message.image_uri,
      message.image_width,
      message.image_height,
      message.gif_url,
      message.gif_width,
      message.gif_height,
      message.video_uri,
      message.video_width,
      message.video_height,
      message.video_duration_ms,
      message.video_size,
      message.file_uri,
      message.file_name,
      message.file_mime,
      message.file_size,
      message.media_url,
      message.media_key,
      message.media_nonce,
      message.media_status,
    ]
  );
}

export function setMessageMediaStatus(id: string, status: MediaStatus): void {
  db.runSync(`UPDATE messages SET media_status = ? WHERE id = ?`, [status, id]);
}

// Called once an S3-backed attachment's ciphertext has been downloaded and
// decrypted — persists the plaintext local file uri and clears the transfer
// state. One setter per kind since each writes a different *_uri column.
export function setMessageImageLocal(id: string, uri: string): void {
  db.runSync(`UPDATE messages SET image_uri = ?, media_status = 'ready' WHERE id = ?`, [uri, id]);
}

export function setMessageVideoLocal(id: string, uri: string): void {
  db.runSync(`UPDATE messages SET video_uri = ?, media_status = 'ready' WHERE id = ?`, [uri, id]);
}

export function setMessageFileLocal(id: string, uri: string): void {
  db.runSync(`UPDATE messages SET file_uri = ?, media_status = 'ready' WHERE id = ?`, [uri, id]);
}

export function setMyReaction(id: string, emoji: string | null): void {
  db.runSync(`UPDATE messages SET reaction_mine = ? WHERE id = ?`, [emoji, id]);
}

export function setPeerReaction(id: string, emoji: string | null): void {
  db.runSync(`UPDATE messages SET reaction_peer = ? WHERE id = ?`, [emoji, id]);
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

export function clearMessages(conversationId: string): void {
  db.runSync(`DELETE FROM messages WHERE conversation_id = ?`, [conversationId]);
}

export function deleteMessagesBefore(conversationId: string, before: number): void {
  db.runSync(`DELETE FROM messages WHERE conversation_id = ? AND sent_at < ?`, [conversationId, before]);
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

// 'accepted' is both the legacy default (conversations that predate this
// column) and the state after a contact request is accepted. 'declined' is
// only ever seen on the requester's side — once the recipient decides
// (accept/decline), their own row is deleted rather than left declined, see
// contactRequests.ts.
export type ConversationStatus = "accepted" | "pending_outgoing" | "pending_incoming" | "declined";

export interface ConversationRow {
  id: string;
  peer_public_key: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
  status: ConversationStatus;
  contact_number: string | null;
}

export function getConversations(): ConversationRow[] {
  return db.getAllSync<ConversationRow>(`SELECT * FROM conversations ORDER BY created_at DESC`);
}

export interface ConversationSummary extends ConversationRow {
  last_message: string | null;
  last_message_at: number | null;
  last_message_direction: "outgoing" | "incoming" | null;
  last_message_status: MessageStatus | null;
  unread_count: number;
  // 0/1 — SQLite has no native boolean type; treat as truthy in TS.
  is_blocked: number;
}

export function getConversationSummaries(): ConversationSummary[] {
  return db.getAllSync<ConversationSummary>(`
    SELECT
      c.*,
      (SELECT CASE WHEN m.deleted_at IS NOT NULL THEN 'This message was deleted' ELSE m.plaintext END
         FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message,
      (SELECT sent_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message_at,
      (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message_direction,
      (SELECT status FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1) AS last_message_status,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'incoming' AND m.read_at IS NULL) AS unread_count,
      EXISTS(SELECT 1 FROM blocked_users b WHERE b.peer_id = c.id) AS is_blocked
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

// OR IGNORE rather than a plain INSERT: callers that materialize a
// conversation from an incoming message/reaction (see MessagingContext)
// can race two events from the same brand-new sender, both finding no
// existing row before either one inserts.
export function insertConversation(conversation: ConversationRow): void {
  db.runSync(
    `INSERT OR IGNORE INTO conversations (id, peer_public_key, display_name, avatar_url, created_at, status, contact_number) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      conversation.id,
      conversation.peer_public_key,
      conversation.display_name,
      conversation.avatar_url,
      conversation.created_at,
      conversation.status,
      conversation.contact_number,
    ]
  );
}

// Flips a conversation's request-gate state (e.g. their contact request was
// accepted/declined, or ours was) — see contactRequests.ts and
// MessagingContext's contact:accepted/contact:declined handlers.
export function setConversationStatus(id: string, status: ConversationStatus): void {
  db.runSync(`UPDATE conversations SET status = ? WHERE id = ?`, [status, id]);
}

// Refreshes a peer's cached name/avatar/contact number for an existing
// conversation (e.g. they updated their profile after the conversation was
// first created) — insertConversation only ever writes these once, on first
// contact.
export function updateConversationProfile(
  id: string,
  displayName: string | null,
  avatarUrl: string | null,
  contactNumber: string | null
): void {
  db.runSync(`UPDATE conversations SET display_name = ?, avatar_url = ?, contact_number = ? WHERE id = ?`, [
    displayName,
    avatarUrl,
    contactNumber,
    id,
  ]);
}

// Refreshes a peer's cached public key (e.g. they reinstalled or re-registered,
// rotating their identity keypair) — insertConversation only ever writes this
// once, on first contact, so a stale local copy silently breaks encrypt/decrypt
// with them until this is called. See MessagingContext's decrypt-retry path.
export function updateConversationPeerKey(id: string, peerPublicKey: string): void {
  db.runSync(`UPDATE conversations SET peer_public_key = ? WHERE id = ?`, [peerPublicKey, id]);
}

export interface PeerDeviceRow {
  device_id: string;
  public_key: string;
}

export function getPeerDevices(conversationId: string): PeerDeviceRow[] {
  return db.getAllSync<PeerDeviceRow>(
    `SELECT device_id, public_key FROM peer_devices WHERE conversation_id = ?`,
    [conversationId]
  );
}

// Wholesale replace rather than upsert: a device that's no longer in the
// fetched list has been unlinked/revoked on the server and must stop being
// a valid send target here too, not just silently linger as stale cache.
export function replacePeerDevices(conversationId: string, devices: PeerDeviceRow[]): void {
  db.withTransactionSync(() => {
    db.runSync(`DELETE FROM peer_devices WHERE conversation_id = ?`, [conversationId]);
    for (const device of devices) {
      db.runSync(`INSERT INTO peer_devices (conversation_id, device_id, public_key) VALUES (?, ?, ?)`, [
        conversationId,
        device.device_id,
        device.public_key,
      ]);
    }
  });
}

// Removes the conversation itself along with its messages and call history —
// unlike clearMessages(), nothing is left behind in the chat list.
export function deleteConversationRecord(conversationId: string): void {
  db.withTransactionSync(() => {
    db.runSync(`DELETE FROM messages WHERE conversation_id = ?`, [conversationId]);
    db.runSync(`DELETE FROM calls WHERE conversation_id = ?`, [conversationId]);
    db.runSync(`DELETE FROM peer_devices WHERE conversation_id = ?`, [conversationId]);
    db.runSync(`DELETE FROM conversations WHERE id = ?`, [conversationId]);
  });
}

// Blocking is enforced entirely on-device (there's no server-side concept of
// it): a blocked peer's conversation id is their user id, so this same id is
// used to drop their incoming messages and to keep them out of contact/add
// flows going forward.
export function blockUser(peerId: string): void {
  db.runSync(`INSERT OR REPLACE INTO blocked_users (peer_id, blocked_at) VALUES (?, ?)`, [
    peerId,
    Date.now(),
  ]);
}

export function isUserBlocked(peerId: string): boolean {
  return db.getFirstSync(`SELECT 1 FROM blocked_users WHERE peer_id = ?`, [peerId]) != null;
}

export function getBlockedUserIds(): Set<string> {
  return new Set(
    db.getAllSync<{ peer_id: string }>(`SELECT peer_id FROM blocked_users`).map((row) => row.peer_id)
  );
}

export interface BlockedUserRow {
  peer_id: string;
  blocked_at: number;
  // Cached from conversations, if a row for this peer still exists —
  // blocking via a contact-request decline deletes the conversation row
  // entirely (see contactRequests.ts), so these are frequently null and the
  // Blocked Users screen falls back to a live lookup for display.
  display_name: string | null;
  avatar_url: string | null;
}

export function listBlockedUsers(): BlockedUserRow[] {
  return db.getAllSync<BlockedUserRow>(
    `SELECT b.peer_id, b.blocked_at, c.display_name, c.avatar_url
     FROM blocked_users b
     LEFT JOIN conversations c ON c.id = b.peer_id
     ORDER BY b.blocked_at DESC`
  );
}

export function unblockUser(peerId: string): void {
  db.runSync(`DELETE FROM blocked_users WHERE peer_id = ?`, [peerId]);
}

export type CallDirection = "outgoing" | "incoming";
export type CallKind = "audio" | "video";
export type CallStatus = "completed" | "missed" | "declined" | "failed";

export interface CallRow {
  id: string;
  conversation_id: string;
  direction: CallDirection;
  kind: CallKind;
  status: CallStatus;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
}

export function insertCall(call: CallRow): void {
  db.runSync(
    `INSERT INTO calls (id, conversation_id, direction, kind, status, started_at, answered_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      call.id,
      call.conversation_id,
      call.direction,
      call.kind,
      call.status,
      call.started_at,
      call.answered_at,
      call.ended_at,
    ]
  );
}

export function updateCallOutcome(
  id: string,
  status: CallStatus,
  answeredAt: number | null,
  endedAt: number
): void {
  db.runSync(`UPDATE calls SET status = ?, answered_at = ?, ended_at = ? WHERE id = ?`, [
    status,
    answeredAt,
    endedAt,
    id,
  ]);
}

// Powers the inline call log shown in the chat itself (interleaved with
// messages), as opposed to getCallHistory()'s cross-conversation list.
export function getCallsForConversation(conversationId: string): CallRow[] {
  return db.getAllSync<CallRow>(
    `SELECT * FROM calls WHERE conversation_id = ? ORDER BY started_at ASC`,
    [conversationId]
  );
}

export interface CallHistoryEntry extends CallRow {
  display_name: string | null;
}

export function getCallHistory(): CallHistoryEntry[] {
  return db.getAllSync<CallHistoryEntry>(`
    SELECT calls.*, conversations.display_name
    FROM calls
    JOIN conversations ON conversations.id = calls.conversation_id
    ORDER BY calls.started_at DESC
  `);
}

export default db;
