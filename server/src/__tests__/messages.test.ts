import { randomUUID } from "node:crypto";
import { db, initDatabase } from "../db";
import { users } from "../schema";
import {
  clearReaction,
  getUndeliveredMessages,
  getUndeliveredReactions,
  markDelivered,
  setReaction,
  storeMessage,
} from "../messages";

function seedUser(id: string, email: string) {
  db.insert(users)
    .values({
      id,
      email,
      public_key: `${email}-pubkey`,
      current_session_id: `${id}-session`,
      created_at: Date.now(),
      last_seen_at: null,
    })
    .run();
}

beforeAll(() => {
  initDatabase();
  seedUser("sender-1", "sender-one@example.com");
  seedUser("recipient-1", "recipient-one@example.com");
  seedUser("recipient-2", "recipient-two@example.com");
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

    markDelivered(message.id, "recipient-1");

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

describe("reactions", () => {
  it("upserts a reaction per (message, reactor) and tracks delivery like messages", () => {
    const messageId = randomUUID();

    const first = setReaction({
      messageId,
      senderId: "recipient-1",
      recipientId: "sender-1",
      ciphertext: "cipher-thumbs-up",
      nonce: "nonce-1",
    });
    expect(getUndeliveredReactions("sender-1")).toEqual([first]);

    // Reacting again with a different emoji overwrites rather than adding a row.
    const second = setReaction({
      messageId,
      senderId: "recipient-1",
      recipientId: "sender-1",
      ciphertext: "cipher-heart",
      nonce: "nonce-2",
    });
    const undelivered = getUndeliveredReactions("sender-1");
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]).toEqual(second);
  });

  it("removes the row on clear", () => {
    const messageId = randomUUID();
    setReaction({
      messageId,
      senderId: "recipient-2",
      recipientId: "sender-1",
      ciphertext: "cipher-blob",
      nonce: "nonce-value",
    });

    clearReaction(messageId, "recipient-2");

    expect(getUndeliveredReactions("sender-1").some((r) => r.message_id === messageId)).toBe(false);
  });
});
