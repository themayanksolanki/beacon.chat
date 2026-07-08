import { Router } from "express";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { users } from "../schema";
import { requireAuth, type AuthedRequest } from "../auth";
import { sendInviteEmail } from "../email";
import { isMongoConnected, profiles } from "../mongo";

export const usersRouter = Router();

const MAX_LOOKUP_EMAILS = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

usersRouter.get("/by-email/:email/public-key", requireAuth, (req, res) => {
  const email = String(req.params.email);
  const user = db.select().from(users).where(eq(users.email, email)).get();

  if (!user || !user.public_key) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  res.json({ userId: user.id, publicKey: user.public_key });
});

/**
 * Bulk email lookup: the app sends candidate emails (typed manually or read
 * from the device's address book) and gets back only the ones registered on
 * Beacon (with a public key, i.e. they've completed OTP verification at
 * least once), enriched with their Mongo-stored display name/avatar. Used to
 * distinguish "chat" vs "invite" in the add-by-email screen.
 */
usersRouter.post("/lookup", requireAuth, async (req, res) => {
  const { emails } = req.body ?? {};

  if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) {
    res.status(400).json({ error: "emails must be an array of strings" });
    return;
  }

  const unique = [...new Set(emails)].slice(0, MAX_LOOKUP_EMAILS);
  if (unique.length === 0) {
    res.json({ matches: [] });
    return;
  }

  const rows = db
    .select({ id: users.id, email: users.email, public_key: users.public_key })
    .from(users)
    .where(and(inArray(users.email, unique), isNotNull(users.public_key)))
    .all();

  const profileByUserId = isMongoConnected()
    ? new Map(
        (await profiles().find({ userId: { $in: rows.map((r) => r.id) } }).toArray()).map((p) => [
          p.userId,
          p,
        ])
      )
    : new Map();

  res.json({
    matches: rows.map((r) => {
      const profile = profileByUserId.get(r.id);
      return {
        email: r.email,
        userId: r.id,
        publicKey: r.public_key,
        name: profile?.name ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
      };
    }),
  });
});

/** Invites someone not yet on Beacon via a real email with a join link. */
usersRouter.post("/invite", requireAuth, async (req: AuthedRequest, res) => {
  const { email } = req.body ?? {};

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  const inviter = db.select().from(users).where(eq(users.id, req.user!.userId)).get();

  await sendInviteEmail(email, inviter?.email ?? "A Beacon user");
  res.status(202).json({ ok: true });
});
