import { Router } from "express";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { users } from "../schema";
import { requireAuth, type AuthedRequest } from "../auth";
import { sendInviteEmail } from "../email";
import { isMongoConnected, profiles, resolveAvatarUrl } from "../mongo";
import { normalizeEmail } from "../util";

export const usersRouter = Router();

const MAX_LOOKUP_EMAILS = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

usersRouter.get("/by-email/:email/public-key", requireAuth, (req, res) => {
  const email = normalizeEmail(String(req.params.email));
  const user = db.select().from(users).where(eq(users.email, email)).get();

  if (!user || !user.public_key) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  res.json({ userId: user.id, publicKey: user.public_key });
});

/**
 * Resolves a bare user id to their identity/profile. Used by the client to
 * materialize a local conversation for a sender it has no prior relationship
 * with (e.g. someone who added you by email before you added them back) —
 * incoming messages/reactions only carry the sender's id, not their email.
 */
usersRouter.get("/by-id/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const user = db.select().from(users).where(eq(users.id, id)).get();

  if (!user || !user.public_key) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  const profile = isMongoConnected() ? await profiles().findOne({ userId: id }) : null;

  res.json({
    userId: user.id,
    email: user.email,
    publicKey: user.public_key,
    name: profile?.name ?? null,
    avatarUrl: profile ? resolveAvatarUrl(profile) : null,
  });
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

  const unique = [...new Set(emails.map(normalizeEmail))].slice(0, MAX_LOOKUP_EMAILS);
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
        avatarUrl: profile ? resolveAvatarUrl(profile) : null,
      };
    }),
  });
});

/**
 * Bulk phone-number lookup, mirroring /users/lookup above — same
 * "chat vs not found" purpose for the add-contact screen's phone search,
 * except there's no invite-by-SMS path, so unmatched numbers just come
 * back absent from `matches`.
 */
usersRouter.post("/lookup-by-phone", requireAuth, async (req, res) => {
  const { phoneNumbers } = req.body ?? {};

  if (!Array.isArray(phoneNumbers) || phoneNumbers.some((p) => typeof p !== "string")) {
    res.status(400).json({ error: "phoneNumbers must be an array of strings" });
    return;
  }

  const unique = [...new Set(phoneNumbers)].slice(0, MAX_LOOKUP_EMAILS);
  if (unique.length === 0) {
    res.json({ matches: [] });
    return;
  }

  const rows = db
    .select({ id: users.id, contact_number: users.contact_number, public_key: users.public_key })
    .from(users)
    .where(and(inArray(users.contact_number, unique), isNotNull(users.public_key)))
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
        phoneNumber: r.contact_number,
        userId: r.id,
        publicKey: r.public_key,
        name: profile?.name ?? null,
        avatarUrl: profile ? resolveAvatarUrl(profile) : null,
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
  const normalizedEmail = normalizeEmail(email);

  // Guards against inviting someone who's already on the platform — the
  // client is expected to have already routed them to a contact request via
  // /users/lookup, but re-check here so a stale client/cache can't still
  // fire a real "join Beacon" email at an existing account.
  const existing = db
    .select({ public_key: users.public_key })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .get();
  if (existing?.public_key) {
    res.status(409).json({ error: "already_registered" });
    return;
  }

  const inviter = db.select().from(users).where(eq(users.id, req.user!.userId)).get();

  await sendInviteEmail(normalizedEmail, inviter?.email ?? "A Beacon user");
  res.status(202).json({ ok: true });
});
