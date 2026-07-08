import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { db, initDatabase } from "../db";
import { messages, users } from "../schema";
import { ACCOUNT_DELETION_GRACE_MS, purgeExpiredAccounts } from "../accountDeletion";
import { storeMessage } from "../messages";

jest.mock("../email", () => ({ sendOtpEmail: jest.fn(), sendInviteEmail: jest.fn() }));
import { sendOtpEmail } from "../email";

beforeAll(() => {
  initDatabase();
});

function lastOtpCode(): string {
  const mock = sendOtpEmail as unknown as jest.Mock;
  const [, code] = mock.mock.calls[mock.mock.calls.length - 1];
  return code;
}

async function loginAs(app: ReturnType<typeof createApp>, email: string) {
  await request(app).post("/auth/otp/request").send({ email });
  const verify = await request(app)
    .post("/auth/otp/verify")
    .send({ email, code: lastOtpCode(), publicKey: `${email}-pubkey` });
  return verify.body.token as string;
}

describe("account deletion", () => {
  it("requesting deletion revokes the current session and marks the account pending", async () => {
    const app = createApp();
    const email = "dana@example.com";
    const token = await loginAs(app, email);

    const deleteRes = await request(app)
      .post("/auth/account/delete")
      .set("Authorization", `Bearer ${token}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    const sessionRes = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${token}`);
    expect(sessionRes.status).toBe(401);

    const user = db.select().from(users).where(eq(users.email, email)).get();
    expect(user?.deletion_requested_at).not.toBeNull();
  });

  it("logging back in before the grace period cancels the pending deletion", async () => {
    const app = createApp();
    const email = "erin@example.com";
    const firstToken = await loginAs(app, email);

    await request(app).post("/auth/account/delete").set("Authorization", `Bearer ${firstToken}`);
    const pending = db.select().from(users).where(eq(users.email, email)).get();
    expect(pending?.deletion_requested_at).not.toBeNull();

    const secondToken = await loginAs(app, email);
    const reactivated = db.select().from(users).where(eq(users.email, email)).get();
    expect(reactivated?.deletion_requested_at).toBeNull();

    const sessionRes = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${secondToken}`);
    expect(sessionRes.status).toBe(200);
  });

  it("purges accounts whose grace period has elapsed, along with their messages", async () => {
    const userId = randomUUID();
    const email = "frank@example.com";
    db.insert(users)
      .values({
        id: userId,
        email,
        public_key: "frank-pubkey",
        current_session_id: null,
        created_at: Date.now(),
        last_seen_at: null,
        deletion_requested_at: Date.now() - ACCOUNT_DELETION_GRACE_MS - 1,
      })
      .run();
    storeMessage({
      id: randomUUID(),
      senderId: userId,
      recipientId: userId,
      ciphertext: "cipher",
      nonce: "nonce",
    });

    await purgeExpiredAccounts();

    expect(db.select().from(users).where(eq(users.id, userId)).get()).toBeUndefined();
    expect(db.select().from(messages).where(eq(messages.sender_id, userId)).all()).toHaveLength(0);
  });

  it("leaves accounts within the grace period alone", async () => {
    const userId = randomUUID();
    const email = "grace@example.com";
    db.insert(users)
      .values({
        id: userId,
        email,
        public_key: "grace-pubkey",
        current_session_id: null,
        created_at: Date.now(),
        last_seen_at: null,
        deletion_requested_at: Date.now() - 1000,
      })
      .run();

    await purgeExpiredAccounts();

    expect(db.select().from(users).where(eq(users.id, userId)).get()).not.toBeUndefined();
  });
});
