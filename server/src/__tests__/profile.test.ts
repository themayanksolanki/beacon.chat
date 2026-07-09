import request from "supertest";
import { createApp } from "../app";
import { initDatabase } from "../db";

interface FakeProfileDoc {
  userId: string;
  email: string;
  name: string;
  avatarKey: string | null;
  avatarUrl: string | null;
  updatedAt: number;
}

const BUCKET_URL = "https://test-bucket.s3.test-region.amazonaws.com";
const store = new Map<string, FakeProfileDoc>();

function fakeResolveAvatarUrl(doc: Pick<FakeProfileDoc, "avatarKey" | "avatarUrl">): string | null {
  if (doc.avatarKey) return `${BUCKET_URL}/${doc.avatarKey}`;
  return doc.avatarUrl ?? null;
}

jest.mock("../mongo", () => ({
  isMongoConnected: () => true,
  profiles: () => ({
    findOne: async ({ userId }: { userId: string }) => store.get(userId) ?? null,
    updateOne: async (
      { userId }: { userId: string },
      update: { $set: Partial<FakeProfileDoc> }
    ) => {
      const existing = store.get(userId);
      store.set(userId, { ...(existing ?? {}), ...update.$set } as FakeProfileDoc);
    },
    findOneAndDelete: async ({ userId }: { userId: string }) => {
      const existing = store.get(userId) ?? null;
      store.delete(userId);
      return existing;
    },
  }),
  resolveAvatarUrl: (doc: FakeProfileDoc) => fakeResolveAvatarUrl(doc),
}));

const s3State = { configured: true };
jest.mock("../s3", () => ({
  isS3Configured: () => s3State.configured,
  createAvatarUploadPost: jest.fn(async (userId: string) => ({
    url: `${BUCKET_URL}/`,
    fields: { key: `avatars/${userId}/mock.jpg`, policy: "mock-policy" },
    key: `avatars/${userId}/mock.jpg`,
  })),
  deleteAvatarObject: jest.fn(async () => {}),
  headAvatarObject: jest.fn(async () => true),
  publicAvatarUrl: (key: string) => `${BUCKET_URL}/${key}`,
}));

jest.mock("../email", () => ({ sendOtpEmail: jest.fn(), sendInviteEmail: jest.fn() }));
import { sendOtpEmail } from "../email";
import { headAvatarObject } from "../s3";

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  store.clear();
  s3State.configured = true;
  (headAvatarObject as jest.Mock).mockResolvedValue(true);
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

describe("POST /profile/avatar/upload-url", () => {
  it("requires auth", async () => {
    const app = createApp();
    const res = await request(app).post("/profile/avatar/upload-url");
    expect(res.status).toBe(401);
  });

  it("returns a presigned post scoped to the caller's own key prefix", async () => {
    const app = createApp();
    const { token, userId } = await signUp(app, "alice@example.com");

    const res = await request(app)
      .post("/profile/avatar/upload-url")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.key).toBe(`avatars/${userId}/mock.jpg`);
    expect(res.body.fields.key).toBe(`avatars/${userId}/mock.jpg`);
  });

  it("returns 503 when S3 isn't configured", async () => {
    s3State.configured = false;
    const app = createApp();
    const { token } = await signUp(app, "bob@example.com");

    const res = await request(app)
      .post("/profile/avatar/upload-url")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("avatar_upload_unavailable");
  });
});

describe("PUT /profile", () => {
  it("rejects an avatarKey outside the caller's own prefix", async () => {
    const app = createApp();
    const { token } = await signUp(app, "carol@example.com");

    const res = await request(app)
      .put("/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Carol", avatarKey: "avatars/someone-else/forged.jpg" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_avatar_key");
  });

  it("rejects an avatarKey that doesn't exist in S3", async () => {
    (headAvatarObject as jest.Mock).mockResolvedValueOnce(false);
    const app = createApp();
    const { token, userId } = await signUp(app, "dana@example.com");

    const res = await request(app)
      .put("/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Dana", avatarKey: `avatars/${userId}/never-uploaded.jpg` });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_avatar_key");
  });

  it("a name-only edit doesn't clobber a previously-set avatarKey", async () => {
    const app = createApp();
    const { token, userId } = await signUp(app, "erin@example.com");

    const withPhoto = await request(app)
      .put("/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Erin", avatarKey: `avatars/${userId}/photo1.jpg` });
    expect(withPhoto.status).toBe(200);

    const nameOnly = await request(app)
      .put("/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Erin Updated" });
    expect(nameOnly.status).toBe(200);

    const me = await request(app).get("/profile/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.profile).toMatchObject({
      name: "Erin Updated",
      avatarUrl: `${BUCKET_URL}/avatars/${userId}/photo1.jpg`,
    });
  });
});

describe("GET /profile/me", () => {
  it("prefers an S3-derived avatarUrl over a legacy embedded one", async () => {
    const app = createApp();
    const { token, userId } = await signUp(app, "frank@example.com");

    store.set(userId, {
      userId,
      email: "frank@example.com",
      name: "Frank",
      avatarKey: `avatars/${userId}/new.jpg`,
      avatarUrl: "data:image/jpeg;base64,legacy",
      updatedAt: Date.now(),
    });

    const res = await request(app).get("/profile/me").set("Authorization", `Bearer ${token}`);

    expect(res.body.profile.avatarUrl).toBe(`${BUCKET_URL}/avatars/${userId}/new.jpg`);
  });
});
