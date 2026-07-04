import { randomUUID } from "node:crypto";
import { db, initDatabase } from "../db";
import { getUndeliveredMessages, markDelivered, storeMessage } from "../messages";

function seedUser(id: string, phoneNumber: string) {
  db.prepare(
    "INSERT INTO users (id, phone_number, public_key, current_session_id, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, phoneNumber, `${phoneNumber}-pubkey`, `${id}-session`, Date.now());
}

beforeAll(() => {
  initDatabase();
  seedUser("sender-1", "sender-one");
  seedUser("recipient-1", "recipient-one");
  seedUser("recipient-2", "recipient-two");
});

describe("message store", () => {
  it("stores ciphertext and tracks delivery state", () => {
    const message = storeMessage({
      id: randomUUID(),
      senderId: "sender-1",
      recipientId: "recipient-1",
      ciphertext: "cipher-blob",
      nonce: "nonce-value",
    });

    expect(getUndeliveredMessages("recipient-1")).toEqual([message]);

    markDelivered(message.id);

    expect(getUndeliveredMessages("recipient-1")).toEqual([]);
  });

  it("never stores plaintext, only ciphertext + nonce", () => {
    const message = storeMessage({
      id: randomUUID(),
      senderId: "sender-1",
      recipientId: "recipient-2",
      ciphertext: "cipher-blob",
      nonce: "nonce-value",
    });

    expect(Object.keys(message)).not.toContain("plaintext");
  });
});
