import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth, type AuthedRequest } from "../auth";
import { isMongoConnected, profiles, resolveAvatarUrl } from "../mongo";
import { createAvatarUploadPost, deleteAvatarObject, headAvatarObject, isS3Configured } from "../s3";

export const profileRouter = Router();

const MAX_NAME_LENGTH = 80;
// E.164-shaped: a leading '+', a non-zero first digit, then up to 14 more
// digits (matches the ITU E.164 15-digit-total cap).
const PHONE_REGEX = /^\+[1-9]\d{6,14}$/;

profileRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  // Phone lives in Postgres alongside email/publicKey (it's a search key,
  // same role as email) rather than Mongo, so it's available regardless of
  // whether the optional Mongo-backed name/avatar profile store is configured.
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { contactNumber: true },
  });
  const phoneNumber = user?.contactNumber ?? null;

  if (!isMongoConnected()) {
    res.json({ profile: null, phoneNumber });
    return;
  }

  const doc = await profiles().findOne({ userId: req.user!.userId });
  res.json({ profile: doc ? { name: doc.name, avatarUrl: resolveAvatarUrl(doc) } : null, phoneNumber });
});

/**
 * Sets/clears the caller's optional contact number. Unlike email, this is
 * never OTP-verified — it's just a self-reported, unique search key so other
 * users can find this account by phone in the add-contact flow.
 */
profileRouter.put("/phone", requireAuth, async (req: AuthedRequest, res) => {
  const { phoneNumber } = req.body ?? {};

  if (phoneNumber === null) {
    await prisma.user.update({ where: { id: req.user!.userId }, data: { contactNumber: null } });
    res.json({ ok: true });
    return;
  }

  if (typeof phoneNumber !== "string" || !PHONE_REGEX.test(phoneNumber)) {
    res.status(400).json({ error: "invalid_phone_number" });
    return;
  }

  const existing = await prisma.user.findUnique({ where: { contactNumber: phoneNumber }, select: { id: true } });
  if (existing && existing.id !== req.user!.userId) {
    res.status(409).json({ error: "phone_already_registered" });
    return;
  }

  try {
    await prisma.user.update({ where: { id: req.user!.userId }, data: { contactNumber: phoneNumber } });
  } catch {
    // The pre-check above is just for a fast, friendly error in the common
    // case — the unique index is the real guard against a race between two
    // concurrent requests claiming the same number.
    res.status(409).json({ error: "phone_already_registered" });
    return;
  }
  res.json({ ok: true });
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

  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { id: true, email: true },
  });
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
