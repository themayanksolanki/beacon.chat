import sodium from "react-native-libsodium";

let ready = false;

async function ensureReady() {
  if (!ready) {
    await sodium.ready;
    ready = true;
  }
}

/**
 * Encrypts arbitrary file bytes with a fresh random symmetric key, for
 * attachments that go to S3 (see media/chatMediaUpload.ts). Unlike message
 * text (crypto_box, asymmetric — see identity.ts), each file gets its own
 * one-time crypto_secretbox key/nonce; that key+nonce then travel inside the
 * already crypto_box-encrypted message envelope, so only the recipient who
 * can decrypt the envelope ever learns how to decrypt the S3 object. Server
 * and S3 only ever see this function's ciphertext output.
 */
export async function encryptFileBytes(
  plaintext: Uint8Array
): Promise<{ ciphertext: Uint8Array; keyB64: string; nonceB64: string }> {
  await ensureReady();
  const key = sodium.crypto_secretbox_keygen();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  return {
    ciphertext,
    keyB64: sodium.to_base64(key),
    nonceB64: sodium.to_base64(nonce),
  };
}

export async function decryptFileBytes(
  ciphertext: Uint8Array,
  keyB64: string,
  nonceB64: string
): Promise<Uint8Array> {
  await ensureReady();
  return sodium.crypto_secretbox_open_easy(
    ciphertext,
    sodium.from_base64(nonceB64),
    sodium.from_base64(keyB64)
  );
}
