# End-to-end encryption

Code: [`app/src/crypto/identity.ts`](../app/src/crypto/identity.ts),
[`app/src/crypto/fileCrypto.ts`](../app/src/crypto/fileCrypto.ts),
[`app/src/storage/secureKeyStore.ts`](../app/src/storage/secureKeyStore.ts).
Built on [libsodium](https://doc.libsodium.org/) via `react-native-libsodium`.

Messages and media attachments are encrypted on the sender's device and
decrypted only on the recipient's — the server and its database only ever
handle ciphertext. This covers the crypto scheme actually implemented today;
see "Known gaps" below for what it deliberately does not cover yet.

## Identity keys

Every device generates its own X25519 keypair (`sodium.crypto_box_keypair()`)
the first time an account signs into it — see `getOrCreateIdentity` in
`identity.ts`. The private key is written to the OS keychain/keystore via
`expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) and **never leaves the
device or reaches the server**; only the public key is uploaded (`Device.publicKey`
in `schema.prisma`).

Keys are namespaced per account (`secureKeyStore.ts`'s `aliasesFor`), so two
accounts signed into the same physical device get fully independent
identities — neither can decrypt the other's ciphertext.

This is a **static, long-term keypair per device**, not a rotating/ephemeral
one — see "Known gaps."

## Multi-device model

Because this is WhatsApp-style multi-device (one `Device` row per linked
device, each with its own keypair — see `schema.prisma`'s `Device` model),
there is no single "user" key. A sender encrypts one ciphertext **per
recipient device** (`recipientDeviceId` on `Message`/`Reaction`) rather than
once per recipient user, and also encrypts a synced copy for their own other
logged-in devices (`senderDeviceId`) — the same shape as WhatsApp
Web/Desktop seeing your own outbound messages. `routes/users.ts`'s
`/users/:id/devices` is what a sender fetches to learn which of a contact's
devices currently need their own ciphertext.

## Message encryption

`encryptMessage`/`decryptMessage` in `identity.ts` use
`crypto_box_easy`/`crypto_box_open_easy` — X25519 key agreement +
XSalsa20-Poly1305, authenticated and tamper-evident. A fresh random nonce is
generated per message (`crypto_box_NONCEBYTES`) and travels alongside the
ciphertext (`Message.nonce` / `Message.ciphertext`, both opaque strings to
the server).

`MessagingContext.tsx` decrypts with the sender's **currently known** public
key and, on failure, refetches it and retries once (`peer.publicKey === cachedPeerPublicKeyB64
? throw : updateConversationPeerKey(...)`) — this is what lets an existing
conversation keep working after a contact reinstalls the app and gets a new
identity key, without a manual re-verification step (see "Known gaps").

## File/media encryption

Images, videos, voice notes, and generic file attachments are encrypted
before they ever touch the network — see `fileCrypto.ts` and
`media/chatMediaUpload.ts`/`chatMediaDownload.ts`. Each attachment gets its
own one-time symmetric key (`crypto_secretbox_keygen()`) and nonce; the
ciphertext is what actually gets uploaded to S3 via a presigned POST. The
key+nonce are **not** sent to the server directly — they travel only inside
the already `crypto_box`-encrypted message envelope, so only whoever can
decrypt that message ever learns how to decrypt the S3 object. S3 and the
server only ever store/see the encrypted bytes.

## What the server can and cannot see

**Can see (necessarily, to route/relay):** who is messaging whom, when,
message/attachment size, delivery/read receipt timestamps, each device's
public key, and (not E2EE — see below) profile name/avatar and call
signaling metadata.

**Cannot see:** message text, reaction content, or attachment contents —
`Message.ciphertext`/`nonce` and the S3 objects are opaque without a private
key the server never has.

## Known gaps (not implemented yet)

- **No forward secrecy / no ratchet.** Keys are static per device for its
  lifetime — compromising a device's stored private key decrypts every
  message ever exchanged with it, past and future, until the key is
  rotated. A real Signal-protocol-style Double Ratchet (rotating session
  keys per message, X3DH prekeys for encrypting to an offline device) would
  close this; there's a one-line reminder of this left in the top-level
  `readme.md`.
- **No key-verification UI.** There's no "safety number"/fingerprint
  comparison flow, and a changed peer public key is accepted and retried
  against automatically (see "Message encryption" above) rather than
  surfaced to the user — so a server-side key-substitution (MITM) attack
  would currently go unnoticed rather than requiring out-of-band
  re-verification.
- **Profile metadata is plaintext.** Display name and avatar
  (`User.avatarKey`, served as a public S3 URL — see `s3.ts`'s
  `publicAvatarUrl`) are not encrypted at all.
- **Call signaling isn't wrapped in this layer.** SDP offers/answers and ICE
  candidates are relayed by the server as plain JSON (`call:invite`,
  `call:answer`, `call:ice-candidate` in `socketServer.ts`) — not
  `crypto_box`-encrypted the way chat messages are. The actual call media
  itself is still end-to-end encrypted, because WebRTC mandates DTLS-SRTP
  between the two peers regardless; what's missing is hiding the
  signaling metadata (who's calling whom, call kind) from the server, which
  already sees it anyway to route the invite.
- **No group chats**, so there's no group-key/sender-key distribution
  problem yet — every conversation here is 1:1, one ciphertext per device.

## Where this is documented

This file is the detailed reference. `readme.md` (used as a running
notes/TODO file for this project) carries a one-line pointer to the "next
step" gap above rather than repeating this write-up.
