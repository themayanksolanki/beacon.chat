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
});
