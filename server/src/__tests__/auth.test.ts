import request from "supertest";
import { createApp } from "../app";
import { initDatabase } from "../db";

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

describe("email + OTP auth flow", () => {
  it("logs in with email + OTP, and a second-device login revokes the first session", async () => {
    const app = createApp();
    const email = "alice@example.com";

    const requestRes = await request(app).post("/auth/otp/request").send({ email });
    expect(requestRes.status).toBe(202);

    const verifyA = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: lastOtpCode(), publicKey: "device-a-pubkey" });
    expect(verifyA.status).toBe(200);
    const tokenA = verifyA.body.token;

    const sessionA = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(sessionA.status).toBe(200);
    expect(sessionA.body.email).toBe(email);

    // Logging in again (a second device) must invalidate tokenA.
    await request(app).post("/auth/otp/request").send({ email });
    const verifyB = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: lastOtpCode(), publicKey: "device-b-pubkey" });
    expect(verifyB.status).toBe(200);

    const staleSession = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(staleSession.status).toBe(401);
    expect(staleSession.body.error).toBe("session_revoked");
  });

  it("rejects an incorrect OTP code", async () => {
    const app = createApp();
    const email = "bob@example.com";
    await request(app).post("/auth/otp/request").send({ email });

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: "000000", publicKey: "pubkey" });

    expect(res.status).toBe(401);
  });

  it("logout clears the session so the token stops working", async () => {
    const app = createApp();
    const email = "carol@example.com";
    await request(app).post("/auth/otp/request").send({ email });

    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ email, code: lastOtpCode(), publicKey: "pubkey" });
    const token = verifyRes.body.token;

    const logoutRes = await request(app)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(204);

    const sessionRes = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${token}`);
    expect(sessionRes.status).toBe(401);
  });
});
