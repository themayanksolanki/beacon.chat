import request from "supertest";
import { createApp } from "../app";
import { initDatabase } from "../db";

jest.mock("../sms", () => ({ sendOtpSms: jest.fn() }));
import { sendOtpSms } from "../sms";

beforeAll(() => {
  initDatabase();
});

function lastOtpCode(): string {
  const mock = sendOtpSms as unknown as jest.Mock;
  const [, code] = mock.mock.calls[mock.mock.calls.length - 1];
  return code;
}

describe("phone + OTP auth flow", () => {
  it("logs in with phone + OTP, and a second-device login revokes the first session", async () => {
    const app = createApp();
    const phoneNumber = "+15550001111";

    const requestRes = await request(app).post("/auth/otp/request").send({ phoneNumber });
    expect(requestRes.status).toBe(202);

    const verifyA = await request(app)
      .post("/auth/otp/verify")
      .send({ phoneNumber, code: lastOtpCode(), publicKey: "device-a-pubkey" });
    expect(verifyA.status).toBe(200);
    const tokenA = verifyA.body.token;

    const sessionA = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(sessionA.status).toBe(200);
    expect(sessionA.body.phoneNumber).toBe(phoneNumber);

    // Logging in again (a second device) must invalidate tokenA.
    await request(app).post("/auth/otp/request").send({ phoneNumber });
    const verifyB = await request(app)
      .post("/auth/otp/verify")
      .send({ phoneNumber, code: lastOtpCode(), publicKey: "device-b-pubkey" });
    expect(verifyB.status).toBe(200);

    const staleSession = await request(app)
      .get("/auth/session")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(staleSession.status).toBe(401);
    expect(staleSession.body.error).toBe("session_revoked");
  });

  it("rejects an incorrect OTP code", async () => {
    const app = createApp();
    const phoneNumber = "+15550002222";
    await request(app).post("/auth/otp/request").send({ phoneNumber });

    const res = await request(app)
      .post("/auth/otp/verify")
      .send({ phoneNumber, code: "000000", publicKey: "pubkey" });

    expect(res.status).toBe(401);
  });

  it("logout clears the session so the token stops working", async () => {
    const app = createApp();
    const phoneNumber = "+15550003333";
    await request(app).post("/auth/otp/request").send({ phoneNumber });

    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ phoneNumber, code: lastOtpCode(), publicKey: "pubkey" });
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
