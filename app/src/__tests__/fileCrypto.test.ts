import sodium from "react-native-libsodium";
import { encryptFileBytes, decryptFileBytes } from "../crypto/fileCrypto";

describe("file crypto", () => {
  it("round-trips arbitrary bytes", async () => {
    await sodium.ready;
    const plaintext = sodium.randombytes_buf(4096);

    const { ciphertext, keyB64, nonceB64 } = await encryptFileBytes(plaintext);
    const decrypted = await decryptFileBytes(ciphertext, keyB64, nonceB64);

    expect(decrypted).toEqual(plaintext);
  });

  it("throws when decrypting with the wrong key", async () => {
    await sodium.ready;
    const plaintext = sodium.randombytes_buf(64);
    const { ciphertext, nonceB64 } = await encryptFileBytes(plaintext);
    const wrongKey = sodium.to_base64(sodium.crypto_secretbox_keygen());

    await expect(decryptFileBytes(ciphertext, wrongKey, nonceB64)).rejects.toThrow();
  });

  it("throws when decrypting with the wrong nonce", async () => {
    await sodium.ready;
    const plaintext = sodium.randombytes_buf(64);
    const { ciphertext, keyB64 } = await encryptFileBytes(plaintext);
    const wrongNonce = sodium.to_base64(sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES));

    await expect(decryptFileBytes(ciphertext, keyB64, wrongNonce)).rejects.toThrow();
  });
});
