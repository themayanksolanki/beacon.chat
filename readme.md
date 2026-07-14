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

---

Calling requirements

Rewritten against what this repo actually has, not a generic native-app stack — this is one React Native/Expo codebase (not separate native Android/iOS projects), Socket.IO (not raw SIP or a message queue), and Postgres/Prisma (not Mongo). Status tag per line: ✅ already built, ⚠️ built but the reliability audit above found a real problem with it, ❌ doesn't exist yet.

Backend

* ✅ Signaling over the existing Socket.IO connection — `server/src/socketServer.ts` already has `call:invite`, `call:answer`, `call:ice-candidate`, `call:end`, `call:reject`, `call:renegotiate-offer`, plus a busy check via an active-call map. No SIP server, no new transport — new call features are just new event names on the same socket, same as chat.
* ⚠️ TURN — already built as Twilio Network Traversal Service (`server/src/routes/calls.ts` mints short-lived credentials, `CallContext.tsx` fetches them per call and falls back to STUN-only on failure). This is a real coturn/VPS alternative already in place, not missing — but `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` are blank in `.env.example` and I can't confirm they're set on the deployed server. **Confirm that first** before standing up self-hosted coturn as a separate system — it would be duplicate infrastructure solving the same problem. Coturn only makes sense later if Twilio's per-minute relay cost becomes a real line item.
* ❌ Redis pub/sub — doesn't exist anywhere in `server/src`, and isn't needed at a single-server-instance scale (Socket.IO's own room mechanism, `socket.join(userId)`, already fans a call out to every one of a user's connected devices). Only becomes a real requirement if the server is horizontally scaled to multiple instances — at that point add the `socket.io-redis` adapter for both chat and calls together, not calls alone.
* ⚠️ Call log — already a Postgres/Prisma model (`Call` in `schema.prisma`: callId/callerId/calleeId/kind/createdAt/syncedAt), not Mongo. Introducing Mongo alongside Postgres would be a second database for no reason — extend the existing `Call` model/table instead. No media ever touches the server today (WebRTC is P2P/TURN-relayed only) — that's already the correct architecture, keep it.
* ❌ Push (FCM + APNs VoIP/PushKit) — this is the one genuinely missing backend piece, and per the earlier audit it's the most likely cause of "fails when the app is backgrounded/killed." `Device.pushToken` already exists in `schema.prisma` but is never read or written anywhere in `server/src` — the column is there, nothing populates or uses it. Needs: an endpoint to register a device's push token, and `call:invite`'s handler sending a high-priority FCM data message (Android) / VoIP push via PushKit (iOS) when the callee's socket isn't connected, instead of just recording a missed call and letting the 45s ring timeout run out.

Mobile client (React Native — one codebase, not separate native builds)

* ✅ WebRTC — `react-native-webrtc` already installed and wired into `CallContext.tsx` (RTCPeerConnection, offer/answer, ICE candidate queueing, ICE-restart-on-disconnect with polite/impolite glare handling). This *is* the Google WebRTC native SDK, just consumed through its RN wrapper instead of raw `org.webrtc`/`WebRTC.framework` — no need to drop to native SDKs directly.
* ✅ Native call UI (ConnectionService/Telecom on Android, CallKit on iOS) — already unified behind `react-native-callkeep` (`app/plugins/withCallKeepAndroid.js` registers the Android `ConnectionService`; the same library maps to CallKit on iOS). Audio session ownership on iOS: CallKeep already owns this the way the gotcha below describes — if a "no audio" bug shows up on iOS specifically, check for code fighting CallKeep's `AVAudioSession` handling before anything else.
* ✅ Foreground service for ongoing calls — declared in `app.json` (`FOREGROUND_SERVICE_PHONE_CALL`, `FOREGROUND_SERVICE_CAMERA`, `FOREGROUND_SERVICE_MICROPHONE`).
* ⚠️ Permissions — `RECORD_AUDIO`/`CAMERA` are requested (`ensureAndroidCallPermissions` in `CallContext.tsx`). Not present: `BLUETOOTH_CONNECT` (needed for Bluetooth headset audio routing on Android 12+) and `USE_FULL_SCREEN_INTENT` (Android 14 restricts this to declared call/alarm apps — needed for the incoming-call screen to actually show over the lock screen; without it CallKeep's incoming-call intent may silently degrade to a notification instead of a full-screen UI on Android 14 devices). Both need adding to `app.json`.
* ✅ Codecs — Opus/VP8/H.264 come free with `react-native-webrtc`, nothing to configure.
* ✅ Ring timeout, busy detection, ICE restart on network switch, audio routing — `RING_TIMEOUT_MS = 45000`, `restartIce()` + renegotiation on `disconnected`/`failed` state, and `react-native-incall-manager` (already a dependency) for earpiece/speaker/Bluetooth routing are all already implemented in `CallContext.tsx`. Proximity-sensor screen-off during audio calls is `react-native-incall-manager`'s default behavior once it's started for a call — not something separately verified working end-to-end here.
* ✅ Missed calls sync to the client — `call:missed` (server) → the local `calls` SQLite table, merged chronologically into the same chat timeline as messages (`ChatScreen.tsx`'s combined message+call list). Not literally the `messages` table as the generic version of this doc assumed, but the same effect: a missed call shows up inline in the conversation.

Implementation steps (only what's not already done)

1. Confirm `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` are set wherever the server actually runs — the single highest-leverage fix per the calling audit above, and already-built plumbing away from being effective.
2. Add a timeout to the TURN-credential fetch (`getTurnCredentials` in `api/client.ts` currently has none) so a slow/hung request degrades to STUN-only in a few seconds instead of stalling call setup indefinitely.
3. Add `BLUETOOTH_CONNECT` and `USE_FULL_SCREEN_INTENT` to `app.json`'s Android permissions.
4. Build push wake-up: register/store `Device.pushToken` server-side (column already exists, unused), send an FCM high-priority data push carrying the pending `call_id` on `call:invite` when the callee's socket is dead, and add PushKit VoIP push for iOS — note Apple's hard rule: every VoIP push must report to CallKit immediately or iOS revokes the app's VoIP push privileges. Expo's `expo-notifications` covers standard FCM but not PushKit's separate VoIP push type; this likely needs a small dedicated native module/config plugin, same pattern as the existing CallKeep plugin.
5. Test the matrix nobody's systematically run yet: both parties behind symmetric NAT (forces TURN), app killed, DND mode, mic/camera permission denied mid-call, backgrounding during ring. This is genuinely new work — the reliability bug report that started this investigation is itself evidence this hasn't been tested end-to-end.

Key gotchas (stack-agnostic, still apply here)

* Don't skip fixing the existing TURN integration thinking "P2P mostly works" — symmetric NAT on mobile carriers (very common in India) makes relay unavoidable, and this repo's own code comments already diagnose that exact failure mode.
* WebRTC's DTLS-SRTP already encrypts 1:1 call media end-to-end; `docs/encryption.md`'s own caveat applies here too — only the *signaling* (SDP/ICE over the socket) isn't wrapped in this app's separate message-encryption layer, not the media itself. WhatsApp-level E2EE work only becomes relevant if group calls are added via an SFU later (insertable streams/frame encryption).
* iOS audio: let CallKit own the `AVAudioSession` via `react-native-callkeep` — fighting it is the #1 source of "no audio" bugs, and this app already depends on CallKeep for exactly this reason.

Later: group calls

No group-call code exists in this repo today (every call is scoped to a single `conversationId`, 1:1 only). When that's needed, an SFU (LiveKit or mediasoup) replaces the peer-connection topology — the 1:1 signaling events above stay as the baseline and just get a "which SFU room" layer on top, not a rewrite.