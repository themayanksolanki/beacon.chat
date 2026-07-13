import request from "supertest";
import { createApp } from "../app";
import { initDatabase } from "../db";

const BUCKET_URL = "https://test-bucket.s3.test-region.amazonaws.com";

const s3State = { configured: true };
jest.mock("../s3", () => ({
  isS3Configured: () => s3State.configured,
  createChatMediaUploadPost: jest.fn(
    async ({ senderId, messageId }: { senderId: string; messageId: string; kind: string }) => {
      const key = `chat-media/${senderId}/${messageId}`;
      return {
        url: `${BUCKET_URL}/`,
        fields: { key, policy: "mock-policy" },
        key,
        publicUrl: `${BUCKET_URL}/${key}`,
        maxBytes: 10 * 1024 * 1024,
      };
    }
  ),
}));

jest.mock("../email", () => ({ sendOtpEmail: jest.fn(), sendInviteEmail: jest.fn() }));
import { sendOtpEmail } from "../email";
import { createChatMediaUploadPost } from "../s3";

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  s3State.configured = true;
  (createChatMediaUploadPost as jest.Mock).mockClear();
});

function lastOtpCode(): string {
  const mock = sendOtpEmail as unknown as jest.Mock;
  const [, code] = mock.mock.calls[mock.mock.calls.length - 1];
  return code;
}

async function signUp(app: ReturnType<typeof createApp>, email: string) {
  await request(app).post("/auth/otp/request").send({ email });
  const res = await request(app)
    .post("/auth/otp/verify")
    .send({ email, code: lastOtpCode(), publicKey: `${email}-pubkey` });
  return res.body as { token: string; userId: string };
}

const VALID_MESSAGE_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("POST /media/chat/upload-url", () => {
  it("requires auth", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/media/chat/upload-url")
      .send({ messageId: VALID_MESSAGE_ID, kind: "image" });
    expect(res.status).toBe(401);
  });

  it("returns 503 when S3 isn't configured", async () => {
    s3State.configured = false;
    const app = createApp();
    const { token } = await signUp(app, "alice@example.com");

    const res = await request(app)
      .post("/media/chat/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({ messageId: VALID_MESSAGE_ID, kind: "image" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("chat_media_upload_unavailable");
  });

  it("rejects a malformed messageId", async () => {
    const app = createApp();
    const { token } = await signUp(app, "bob@example.com");

    const res = await request(app)
      .post("/media/chat/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({ messageId: "not-a-uuid", kind: "image" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_message_id");
  });

  it("rejects an invalid kind", async () => {
    const app = createApp();
    const { token } = await signUp(app, "carol@example.com");

    const res = await request(app)
      .post("/media/chat/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({ messageId: VALID_MESSAGE_ID, kind: "voice" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_kind");
  });

  it("returns a presigned post scoped to the caller's own key prefix", async () => {
    const app = createApp();
    const { token, userId } = await signUp(app, "dana@example.com");

    const res = await request(app)
      .post("/media/chat/upload-url")
      .set("Authorization", `Bearer ${token}`)
      .send({ messageId: VALID_MESSAGE_ID, kind: "video" });

    expect(res.status).toBe(200);
    const expectedKey = `chat-media/${userId}/${VALID_MESSAGE_ID}`;
    expect(res.body.key).toBe(expectedKey);
    expect(res.body.fields.key).toBe(expectedKey);
    expect(res.body.publicUrl).toBe(`${BUCKET_URL}/${expectedKey}`);
    expect(createChatMediaUploadPost).toHaveBeenCalledWith({
      senderId: userId,
      messageId: VALID_MESSAGE_ID,
      kind: "video",
    });
  });
});
