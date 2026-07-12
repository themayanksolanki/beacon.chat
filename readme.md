Here's what I found, ranked by impact, with concrete evidence for each.

Server

1. Full-table backfill runs on every server boot — server/src/index.ts:11 calls backfillAcceptedContactsFromMessages() unconditionally on every process start. contacts.ts:98 does prisma.message.findMany({ select: { senderId, recipientId } }) with no limit — loads every message row ever sent into memory — then loops sequentially (for...of with await inside, not batched/parallel) doing one contact.upsert() per unique sender/recipient pair. This was meant as a one-time migration shim for pre-existing chats but now re-runs in full on every restart/deploy. As the messages table grows into the hundreds of thousands, this becomes a multi-minute full scan + thousands of sequential round-trips at every boot.

2. presence:subscribe N+1 — socketServer.ts:381-387 does payload.userIds.map(async (id) => ...prisma.user.findUnique(...)), one DB query per subscribed user id (run concurrently via Promise.all, but still N separate round-trips instead of one findMany({ where: { id: { in: ids } } })). This fires whenever a client opens the conversation/contacts list — for someone with 100+ contacts, that's 100+ individual queries per subscribe call.

3. Unbounded reconnect-flush queries — messages.ts: getUndeliveredMessages, getUnsyncedMessageStatus, and calls.ts's getUnsyncedMissedCalls all use findMany with no take limit. socketServer.ts:113-122 then loops and does one socket.emit(...) per row sequentially (not batched into a single payload). A device offline for a long stretch reconnects to an unbounded query result and a burst of many individual emits.

Client

4. Redundant subqueries in getConversationSummaries — db/database.ts:487-501 runs four separate correlated subqueries (last_message, last_message_at, last_message_direction, last_message_status) that each independently re-derive "the most recent message row for this conversation" via ORDER BY sent_at DESC LIMIT 1 — same lookup done 4x instead of once. Plus an unread_count COUNT and a last_call_at subquery: 6 correlated subqueries per conversation row.

5. That expensive query reruns on every message event, globally — MessagingContext.tsx has a single global revision counter bumped from 13 different call sites (message received/delivered/read, reactions, contact accept/reject, etc.), with no per-conversation scoping. ConversationListScreen.tsx:71-73 re-runs the full getConversationSummaries() (finding #4, across all conversations) on every single bump — so one message in conversation A re-queries and re-renders every other conversation's row too.

6. Missing index on calls — database.ts:81 only has idx_calls_started_at ON calls(started_at), but every calls query (getRecentCalls, getCallsBefore, getCallsFrom, and the last_call_at subquery in #4) filters WHERE conversation_id = ? first. Should be a composite (conversation_id, started_at) index like messages already has — right now these likely fall back to a scan of the whole calls table per conversation.

7. Search defeats FlatList virtualization — ChatScreen.tsx:2686 sets initialNumToRender={listItems.length || 1}, safe under normal pagination since it's bounded by CHAT_ITEM_PAGE_SIZE = 40. But opening search (ChatScreen.tsx:1374-1386) loads the entire unbounded local history via getMessages(conversationId) into messages — on a long-running chat with thousands of messages, that combination forces FlatList to render the whole history synchronously on the next frame instead of windowing it.

Minor: accountDeletion.ts:42-57's hourly sweep does 6 sequential delete queries per due account in a for loop — fine at low volume, would slow down if many deletions land in the same sweep window.

Fix priority

I'd tackle #1 (boot-time full scan — likely the worst in production) and #4/#5 (redundant + over-triggered query, hit on every message) first since they scale with data/usage growth; #6 is a one-line index fix; #2/#3/#7 matter mainly at higher scale (many contacts / long-offline devices / very long chats).

Want me to implement fixes for any of these?

---

End-to-end encryption

Full write-up: docs/encryption.md. Short version: each device has its own X25519 keypair (private key never leaves the device — secure-store only), messages are crypto_box-encrypted per recipient device, attachments get a one-time crypto_secretbox key that travels inside the encrypted message envelope, and the server/S3 only ever see ciphertext.

Optional: upgrade to full Signal-protocol prekeys for offline-device async encryption — current keys are static/long-term (no forward secrecy, no ratchet), and there's no safety-number verification UI yet. Call signaling (SDP/ICE) also isn't wrapped in this layer, only the media itself (via WebRTC's own mandatory DTLS-SRTP).