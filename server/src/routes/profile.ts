import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../schema";
import { requireAuth, type AuthedRequest } from "../auth";
import { isMongoConnected, profiles, resolveAvatarUrl } from "../mongo";
import { createAvatarUploadPost, deleteAvatarObject, headAvatarObject, isS3Configured } from "../s3";

export const profileRouter = Router();

const MAX_NAME_LENGTH = 80;

profileRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  if (!isMongoConnected()) {
    res.json({ profile: null });
    return;
  }

  const doc = await profiles().findOne({ userId: req.user!.userId });
  res.json({ profile: doc ? { name: doc.name, avatarUrl: resolveAvatarUrl(doc) } : null });
});

// Issues a presigned S3 POST policy scoped to this user's own key prefix —
// the client uploads the photo directly to S3, never through this server.
profileRouter.post("/avatar/upload-url", requireAuth, async (req: AuthedRequest, res) => {
  if (!isS3Configured()) {
    res.status(503).json({ error: "avatar_upload_unavailable" });
    return;
  }

  const { url, fields, key } = await createAvatarUploadPost(req.user!.userId);
  res.json({ url, fields, key });
});

profileRouter.put("/", requireAuth, async (req: AuthedRequest, res) => {
  const { name, avatarKey } = req.body ?? {};

  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }

  const avatarKeyProvided = avatarKey !== undefined;
  if (avatarKeyProvided && avatarKey !== null) {
    if (typeof avatarKey !== "string" || !avatarKey.startsWith(`avatars/${req.user!.userId}/`)) {
      res.status(400).json({ error: "invalid_avatar_key" });
      return;
    }
    if (!(await headAvatarObject(avatarKey))) {
      res.status(400).json({ error: "invalid_avatar_key" });
      return;
    }
  }

  if (!isMongoConnected()) {
    res.status(503).json({ error: "profile_store_unavailable" });
    return;
  }

  const user = db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, req.user!.userId))
    .get();
  if (!user) {
    res.status(404).json({ error: "user_not_found" });
    return;
  }

  const previous = await profiles().findOne({ userId: user.id });

  // Only touch avatarKey when the field was actually present in the
  // request body — an omitted field (e.g. a name-only edit) must leave the
  // stored avatar untouched, not clobber it with undefined/null.
  const update: Record<string, unknown> = {
    userId: user.id,
    email: user.email,
    name: name.trim(),
    updatedAt: Date.now(),
  };
  if (avatarKeyProvided) {
    update.avatarKey = avatarKey ?? null;
  }

  await profiles().updateOne({ userId: user.id }, { $set: update }, { upsert: true });

  if (avatarKeyProvided && previous?.avatarKey && previous.avatarKey !== avatarKey) {
    void deleteAvatarObject(previous.avatarKey);
  }

  res.json({ ok: true });
});
