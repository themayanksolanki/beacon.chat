import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { createSocketServer, revokeOtherSessions } from "../socketServer";
import { db, initDatabase } from "../db";
import { users } from "../schema";
import { signToken } from "../auth";

function seedUser(id: string, email: string, sessionId: string) {
  db.insert(users)
    .values({
      id,
      email,
      public_key: `${email}-pubkey`,
      current_session_id: sessionId,
      created_at: Date.now(),
      last_seen_at: null,
    })
    .run();
}

describe("socket relay", () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;

  beforeAll((done: jest.DoneCallback) => {
    initDatabase();
    seedUser("alice-id", "alice@example.com", "alice-session-1");
    seedUser("bob-id", "bob@example.com", "bob-session-1");
    httpServer = createServer();
    createSocketServer(httpServer);
    httpServer.listen(() => {
      port = (httpServer.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done: jest.DoneCallback) => {
    httpServer.close(done);
  });

  function connect(userId: string, sessionId: string): ClientSocket {
    const token = signToken({ userId, sessionId });
    return ioClient(`http://localhost:${port}`, {
      auth: { token },
      transports: ["websocket"],
      forceNew: true,
    });
  }

  it("rejects connections without a valid token", (done: jest.DoneCallback) => {
    const client = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      forceNew: true,
    });

    client.on("connect_error", (err) => {
      expect(err.message).toBe("Missing auth token");
      client.close();
      done();
    });
  });

  it("rejects a token whose session no longer matches the user's current session", (done: jest.DoneCallback) => {
    const client = connect("alice-id", "stale-session");

    client.on("connect_error", (err) => {
      expect(err.message).toBe("session_revoked");
      client.close();
      done();
    });
  });

  it("relays a ciphertext message from sender to recipient", (done: jest.DoneCallback) => {
    const alice = connect("alice-id", "alice-session-1");
    const bob = connect("bob-id", "bob-session-1");

    bob.on("message", (message) => {
      expect(message.sender_id).toBe("alice-id");
      expect(message.ciphertext).toBe("cipher-blob");
      expect(message.nonce).toBe("nonce-value");
      alice.close();
      bob.close();
      done();
    });

    // Both sockets connect independently and in no guaranteed order, so
    // each "connect" listener must be registered up front rather than
    // nested inside the other's callback (nesting risks missing an event
    // that already fired before the inner listener was attached).
    let aliceConnected = false;
    let bobConnected = false;
    const sendIfReady = () => {
      if (aliceConnected && bobConnected) {
        alice.emit("message:send", {
          id: "message-1",
          recipientId: "bob-id",
          ciphertext: "cipher-blob",
          nonce: "nonce-value",
        });
      }
    };
    alice.on("connect", () => {
      aliceConnected = true;
      sendIfReady();
    });
    bob.on("connect", () => {
      bobConnected = true;
      sendIfReady();
    });
  });

  it("relays a reaction from reactor to the message's sender", (done: jest.DoneCallback) => {
    const alice = connect("alice-id", "alice-session-1");
    const bob = connect("bob-id", "bob-session-1");

    alice.on("reaction:set", (reaction) => {
      expect(reaction.message_id).toBe("message-for-reaction");
      expect(reaction.sender_id).toBe("bob-id");
      expect(reaction.ciphertext).toBe("cipher-thumbs-up");
      alice.close();
      bob.close();
      done();
    });

    let aliceConnected = false;
    let bobConnected = false;
    const sendIfReady = () => {
      if (aliceConnected && bobConnected) {
        bob.emit("reaction:set", {
          messageId: "message-for-reaction",
          recipientId: "alice-id",
          ciphertext: "cipher-thumbs-up",
          nonce: "nonce-value",
        });
      }
    };
    alice.on("connect", () => {
      aliceConnected = true;
      sendIfReady();
    });
    bob.on("connect", () => {
      bobConnected = true;
      sendIfReady();
    });
  });

  it("force-disconnects a device's socket when it logs in elsewhere", (done: jest.DoneCallback) => {
    const oldDevice = connect("alice-id", "alice-session-1");
    let sawRevokedEvent = false;

    oldDevice.on("session:revoked", () => {
      sawRevokedEvent = true;
    });

    oldDevice.on("disconnect", () => {
      expect(sawRevokedEvent).toBe(true);
      done();
    });

    oldDevice.on("connect", async () => {
      // Simulate what /auth/otp/verify does on a second-device login.
      db.update(users).set({ current_session_id: "alice-session-2" }).where(eq(users.id, "alice-id")).run();
      await revokeOtherSessions("alice-id");
    });
  });
});
