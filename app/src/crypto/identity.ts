import sodium from "react-native-libsodium";
import { loadIdentityKeys, saveIdentityKeys } from "../storage/secureKeyStore";

let ready = false;

async function ensureReady() {
  if (!ready) {
    await sodium.ready;
    ready = true;
  }
}

export interface Identity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Loads the given account's on-device identity keypair, generating and
 * persisting one the first time that account signs into this device. Each
 * account gets its own keypair so two accounts on one device never share an
 * identity. The private key never leaves the device and is never sent to
 * the server.
 */
export async function getOrCreateIdentity(accountKey: string): Promise<Identity> {
  await ensureReady();

  const stored = await loadIdentityKeys(accountKey);
  if (stored) {
    return {
      publicKey: sodium.from_base64(stored.publicKey),
      privateKey: sodium.from_base64(stored.privateKey),
    };
  }

  const keyPair = sodium.crypto_box_keypair();
  await saveIdentityKeys(
    accountKey,
    sodium.to_base64(keyPair.publicKey),
    sodium.to_base64(keyPair.privateKey)
  );

  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
}

/** Encrypts a message for a recipient's public key using their sender identity. */
export async function encryptMessage(
  plaintext: string,
  recipientPublicKey: Uint8Array,
  senderPrivateKey: Uint8Array
) {
  await ensureReady();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  // crypto_box_easy accepts the message as a plain string directly; unlike
  // libsodium-wrappers (used only in the Jest mock), the native module here
  // doesn't expose a from_string helper at all.
  const ciphertext = sodium.crypto_box_easy(plaintext, nonce, recipientPublicKey, senderPrivateKey);
  return {
    nonce: sodium.to_base64(nonce),
    ciphertext: sodium.to_base64(ciphertext),
  };
}

/** Decrypts a message from a sender's public key using the recipient's identity. */
export async function decryptMessage(
  ciphertextB64: string,
  nonceB64: string,
  senderPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array
) {
  await ensureReady();
  const plaintext = sodium.crypto_box_open_easy(
    sodium.from_base64(ciphertextB64),
    sodium.from_base64(nonceB64),
    senderPublicKey,
    recipientPrivateKey
  );
  return sodium.to_string(plaintext);
}
