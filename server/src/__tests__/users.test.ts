import request from "supertest";
import { createApp } from "../app";
import { initDatabase } from "../db";

jest.mock("../email", () => ({ sendOtpEmail: jest.fn(), sendInviteEmail: jest.fn() }));
import { sendOtpEmail, sendInviteEmail } from "../email";

beforeAll(() => {
  initDatabase();
});

function lastOtpCode(): string {
  const mock = sendOtpEmail as unknown as jest.Mock;
  const [, code] = mock.mock.calls[mock.mock.calls.length - 1];
  return code;
}

async function signUpUser(app: ReturnType<typeof createApp>, email: string, publicKey: string) {
  await request(app).post("/auth/otp/request").send({ email });
  const res = await request(app)
    .post("/auth/otp/verify")
    .send({ email, code: lastOtpCode(), publicKey });
  return res.body as { token: string; userId: string };
}

describe("GET /users/by-email/:email/public-key", () => {
  it("requires auth and returns the recipient's public key", async () => {
    const app = createApp();
    const email = "dave@example.com";

    await request(app).post("/auth/otp/request").send({ email });
    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: lastOtpCode(), publicKey: "bob-pubkey" });
    const { token } = verifyRes.body;

    const unauthed = await request(app).get(`/users/by-email/${email}/public-key`);
    expect(unauthed.status).toBe(401);

    const authed = await request(app)
      .get(`/users/by-email/${email}/public-key`)
      .set("Authorization", `Bearer ${token}`);

    expect(authed.status).toBe(200);
    expect(authed.body.publicKey).toBe("bob-pubkey");
  });
});

describe("GET /users/by-id/:id", () => {
  it("requires auth and resolves a user's identity by id", async () => {
    const app = createApp();
    const email = "frank@example.com";

    await request(app).post("/auth/otp/request").send({ email });
    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: lastOtpCode(), publicKey: "frank-pubkey" });
    const { token, userId } = verifyRes.body;

    const unauthed = await request(app).get(`/users/by-id/${userId}`);
    expect(unauthed.status).toBe(401);

    const authed = await request(app)
      .get(`/users/by-id/${userId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(authed.status).toBe(200);
    expect(authed.body).toMatchObject({ userId, email, publicKey: "frank-pubkey" });

    const missing = await request(app)
      .get("/users/by-id/does-not-exist")
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });
});

describe("POST /users/invite", () => {
  it("requires auth and sends an invite email", async () => {
    const app = createApp();
    const email = "erin@example.com";

    await request(app).post("/auth/otp/request").send({ email });
    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: lastOtpCode(), publicKey: "erin-pubkey" });
    const { token } = verifyRes.body;

    const unauthed = await request(app).post("/users/invite").send({ email: "friend@example.com" });
    expect(unauthed.status).toBe(401);

    const authed = await request(app)
      .post("/users/invite")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "friend@example.com" });

    expect(authed.status).toBe(202);
    expect(sendInviteEmail).toHaveBeenCalledWith("friend@example.com", email);
  });

  it("refuses to invite an email that's already registered", async () => {
    const app = createApp();
    const inviterEmail = "gina@example.com";
    const targetEmail = "harry@example.com";

    await request(app).post("/auth/otp/request").send({ email: inviterEmail });
    const inviterVerify = await request(app)
      .post("/auth/otp/verify")
      .send({ email: inviterEmail, code: lastOtpCode(), publicKey: "gina-pubkey" });
    const { token } = inviterVerify.body;

    await request(app).post("/auth/otp/request").send({ email: targetEmail });
    await request(app)
      .post("/auth/otp/verify")
      .send({ email: targetEmail, code: lastOtpCode(), publicKey: "harry-pubkey" });

    const res = await request(app)
      .post("/users/invite")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: targetEmail });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_registered");
    expect(sendInviteEmail).not.toHaveBeenCalledWith(targetEmail, expect.anything());
  });
});

describe("POST /users/lookup-by-phone", () => {
  it("finds a user by their registered phone number and omits unmatched ones", async () => {
    const app = createApp();
    const { token: leoToken, userId: leoId } = await signUpUser(app, "leo@example.com", "leo-pubkey");

    await request(app)
      .put("/profile/phone")
      .set("Authorization", `Bearer ${leoToken}`)
      .send({ phoneNumber: "+919876543210" });

    const { token: searcherToken } = await signUpUser(app, "mia@example.com", "mia-pubkey");

    const res = await request(app)
      .post("/users/lookup-by-phone")
      .set("Authorization", `Bearer ${searcherToken}`)
      .send({ phoneNumbers: ["+919876543210", "+15555550100"] });

    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).toMatchObject({
      userId: leoId,
      publicKey: "leo-pubkey",
      phoneNumber: "+919876543210",
    });
  });

  it("requires auth", async () => {
    const app = createApp();
    const res = await request(app).post("/users/lookup-by-phone").send({ phoneNumbers: ["+919876543210"] });
    expect(res.status).toBe(401);
  });
});

describe("PUT /profile/phone", () => {
  it("sets and clears a phone number, and reports it back via GET /profile/me", async () => {
    const app = createApp();
    const { token } = await signUpUser(app, "nina@example.com", "nina-pubkey");

    const set = await request(app)
      .put("/profile/phone")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "+14155550132" });
    expect(set.status).toBe(200);

    const me = await request(app).get("/profile/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.phoneNumber).toBe("+14155550132");

    const cleared = await request(app)
      .put("/profile/phone")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: null });
    expect(cleared.status).toBe(200);

    const meAfterClear = await request(app).get("/profile/me").set("Authorization", `Bearer ${token}`);
    expect(meAfterClear.body.phoneNumber).toBeNull();
  });

  it("rejects a malformed phone number", async () => {
    const app = createApp();
    const { token } = await signUpUser(app, "oscar@example.com", "oscar-pubkey");

    const res = await request(app)
      .put("/profile/phone")
      .set("Authorization", `Bearer ${token}`)
      .send({ phoneNumber: "0123-not-a-number" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phone_number");
  });

  it("refuses to link a phone number already claimed by another account", async () => {
    const app = createApp();
    const { token: firstToken } = await signUpUser(app, "petra@example.com", "petra-pubkey");
    await request(app)
      .put("/profile/phone")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ phoneNumber: "+447911123456" });

    const { token: secondToken } = await signUpUser(app, "quinn@example.com", "quinn-pubkey");
    const res = await request(app)
      .put("/profile/phone")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({ phoneNumber: "+447911123456" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_already_registered");
  });
});

describe("email casing is normalized", () => {
  it("finds an already-registered user via /users/lookup regardless of casing", async () => {
    const app = createApp();
    const targetEmail = "Ivy.Nguyen@Example.com";

    await request(app).post("/auth/otp/request").send({ email: targetEmail });
    const targetVerify = await request(app)
      .post("/auth/otp/verify")
      .send({ email: targetEmail, code: lastOtpCode(), publicKey: "ivy-pubkey" });
    const { userId } = targetVerify.body;

    const searcherEmail = "jake@example.com";
    await request(app).post("/auth/otp/request").send({ email: searcherEmail });
    const searcherVerify = await request(app)
      .post("/auth/otp/verify")
      .send({ email: searcherEmail, code: lastOtpCode(), publicKey: "jake-pubkey" });
    const { token } = searcherVerify.body;

    // Searcher types the email in lowercase, as the client's "add by email"
    // flow always normalizes to before calling this endpoint.
    const lookupRes = await request(app)
      .post("/users/lookup")
      .set("Authorization", `Bearer ${token}`)
      .send({ emails: ["ivy.nguyen@example.com"] });

    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.matches).toHaveLength(1);
    expect(lookupRes.body.matches[0]).toMatchObject({ userId, publicKey: "ivy-pubkey" });

    const byEmailRes = await request(app)
      .get("/users/by-email/IVY.NGUYEN@EXAMPLE.COM/public-key")
      .set("Authorization", `Bearer ${token}`);
    expect(byEmailRes.status).toBe(200);
    expect(byEmailRes.body.publicKey).toBe("ivy-pubkey");
  });

  it("logging in with different casing resolves to the same account", async () => {
    const app = createApp();

    await request(app).post("/auth/otp/request").send({ email: "Kelly@Example.com" });
    const first = await request(app)
      .post("/auth/otp/verify")
      .send({ email: "Kelly@Example.com", code: lastOtpCode(), publicKey: "kelly-pubkey-1" });
    expect(first.status).toBe(200);
    const firstUserId = first.body.userId;

    // Same person, typed their email differently on a second device.
    await request(app).post("/auth/otp/request").send({ email: "kelly@example.com" });
    const second = await request(app)
      .post("/auth/otp/verify")
      .send({ email: "kelly@example.com", code: lastOtpCode(), publicKey: "kelly-pubkey-2" });
    expect(second.status).toBe(200);
    expect(second.body.userId).toBe(firstUserId);
  });
});
