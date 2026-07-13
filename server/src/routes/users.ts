import { Router } from "express";
import { prisma } from "../prisma";
import { requireAuth, type AuthedRequest } from "../auth";
import { listActiveDevices } from "../devices";
import { sendInviteEmail } from "../email";
import { resolveAvatarUrl } from "../s3";
import { normalizeEmail } from "../util";

export const usersRouter = Router();

const MAX_LOOKUP_EMAILS = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

usersRouter.get("/by-email/:email/public-key", requireAuth, async (req, res) => {
  const email = normalizeEmail(String(req.params.email));
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.publicKey) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  res.json({ userId: user.id, publicKey: user.publicKey });
});

/**
 * Resolves a bare user id to their identity/profile. Used by the client to
 * materialize a local conversation for a sender it has no prior relationship
 * with (e.g. someone who added you by email before you added them back) —
 * incoming messages/reactions only carry the sender's id, not their email.
 *
 * `devices` is what makes real multi-device encryption possible: a sender
 * fetches this list and encrypts once per active device rather than relying
 * on the single (and, once a second device logs in, stale) `publicKey`
 * column — see app/src/screens/ChatScreen.tsx's send path. `publicKey` is
 * kept for callers that haven't moved to the device list yet.
 */
usersRouter.get("/by-id/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user || !user.publicKey) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  const devices = await listActiveDevices(id);

  res.json({
    userId: user.id,
    email: user.email,
    publicKey: user.publicKey,
    devices: devices.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })),
    name: user.name,
    avatarUrl: resolveAvatarUrl(user.avatarKey),
    about: user.about,
    contactNumber: user.contactNumber,
    createdAt: user.createdAt.getTime(),
  });
});

/**
 * Bulk email lookup: the app sends candidate emails (typed manually or read
 * from the device's address book) and gets back only the ones registered on
 * Beacon (with a public key, i.e. they've completed OTP verification at
 * least once), enriched with their display name/avatar. Used to distinguish
 * "chat" vs "invite" in the add-by-email screen.
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

  const rows = await prisma.user.findMany({
    where: { email: { in: unique }, publicKey: { not: null } },
    select: { id: true, email: true, publicKey: true, name: true, avatarKey: true },
  });

  res.json({
    matches: rows.map((r) => ({
      email: r.email,
      userId: r.id,
      publicKey: r.publicKey,
      name: r.name,
      avatarUrl: resolveAvatarUrl(r.avatarKey),
    })),
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

  const rows = await prisma.user.findMany({
    where: { contactNumber: { in: unique }, publicKey: { not: null } },
    select: { id: true, contactNumber: true, publicKey: true, name: true, avatarKey: true },
  });

  res.json({
    matches: rows.map((r) => ({
      phoneNumber: r.contactNumber,
      userId: r.id,
      publicKey: r.publicKey,
      name: r.name,
      avatarUrl: resolveAvatarUrl(r.avatarKey),
    })),
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
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { publicKey: true } });
  if (existing?.publicKey) {
    res.status(409).json({ error: "already_registered" });
    return;
  }

  const inviter = await prisma.user.findUnique({ where: { id: req.user!.userId } });

  await sendInviteEmail(normalizedEmail, inviter?.email ?? "A Beacon user");
  res.status(202).json({ ok: true });
});
