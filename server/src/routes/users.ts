import { Router } from "express";
import { db } from "../db";
import { requireAuth, type AuthedRequest } from "../auth";
import { sendInviteEmail } from "../email";
import { isMongoConnected, profiles } from "../mongo";

export const usersRouter = Router();

interface UserRow {
  id: string;
  email: string;
  public_key: string | null;
}

const MAX_LOOKUP_EMAILS = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

usersRouter.get("/by-email/:email/public-key", requireAuth, (req, res) => {
  const email = String(req.params.email);
  const user = db.prepare<[string], UserRow>("SELECT * FROM users WHERE email = ?").get(email);

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

  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare<string[], UserRow>(
      `SELECT id, email, public_key FROM users WHERE email IN (${placeholders}) AND public_key IS NOT NULL`
    )
    .all(...unique);

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

  const inviter = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
    .get(req.user!.userId);

  await sendInviteEmail(email, inviter?.email ?? "A Beacon user");
  res.status(202).json({ ok: true });
});
