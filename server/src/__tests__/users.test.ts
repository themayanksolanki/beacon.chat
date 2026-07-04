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

describe("GET /users/by-phone/:phoneNumber/public-key", () => {
  it("requires auth and returns the recipient's public key", async () => {
    const app = createApp();
    const phoneNumber = "+15550009999";

    await request(app).post("/auth/otp/request").send({ phoneNumber });
    const verifyRes = await request(app)
      .post("/auth/otp/verify")
      .send({ phoneNumber, code: lastOtpCode(), publicKey: "bob-pubkey" });
    const { token } = verifyRes.body;

    const unauthed = await request(app).get(`/users/by-phone/${phoneNumber}/public-key`);
    expect(unauthed.status).toBe(401);

    const authed = await request(app)
      .get(`/users/by-phone/${phoneNumber}/public-key`)
      .set("Authorization", `Bearer ${token}`);

    expect(authed.status).toBe(200);
    expect(authed.body.publicKey).toBe("bob-pubkey");
  });
});
