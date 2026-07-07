import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../schema";
import { requireAuth, type AuthedRequest } from "../auth";
import { isMongoConnected, profiles } from "../mongo";

export const profileRouter = Router();

const MAX_NAME_LENGTH = 80;
// Base64 JPEGs from the profile-photo picker land well under this; it's just a
// backstop against accidentally posting something huge into a Mongo document.
const MAX_AVATAR_LENGTH = 2_000_000;

profileRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  if (!isMongoConnected()) {
    res.json({ profile: null });
    return;
  }

  const doc = await profiles().findOne({ userId: req.user!.userId });
  res.json({ profile: doc ? { name: doc.name, avatarUrl: doc.avatarUrl } : null });
});

profileRouter.put("/", requireAuth, async (req: AuthedRequest, res) => {
  const { name, avatarUrl } = req.body ?? {};

  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: "invalid_name" });
    return;
  }
  if (avatarUrl !== undefined && avatarUrl !== null) {
    if (typeof avatarUrl !== "string" || avatarUrl.length > MAX_AVATAR_LENGTH) {
      res.status(400).json({ error: "invalid_avatar" });
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

  await profiles().updateOne(
    { userId: user.id },
    {
      $set: {
        userId: user.id,
        email: user.email,
        name: name.trim(),
        avatarUrl: avatarUrl ?? null,
        updatedAt: Date.now(),
      },
    },
    { upsert: true }
  );

  res.json({ ok: true });
});
