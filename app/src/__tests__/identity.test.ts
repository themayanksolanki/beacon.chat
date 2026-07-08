import sodium from "react-native-libsodium";
import { encryptMessage, decryptMessage } from "../crypto/identity";

describe("identity encryption", () => {
  it("round-trips a message between two keypairs", async () => {
    await sodium.ready;
    const alice = sodium.crypto_box_keypair();
    const bob = sodium.crypto_box_keypair();

    const { ciphertext, nonce } = await encryptMessage(
      "hello bob",
      bob.publicKey,
      alice.privateKey
    );

    const plaintext = await decryptMessage(
      ciphertext,
      nonce,
      alice.publicKey,
      bob.privateKey
    );

    expect(plaintext).toBe("hello bob");
  });
});
