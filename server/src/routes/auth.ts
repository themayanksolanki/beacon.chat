import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { User } from "@prisma/client";
import { prisma } from "../prisma";
import { requireAuth, signToken, type AuthedRequest } from "../auth";
import { resolveLoginDevice } from "../devices";
import { revokeAllUserSessions, revokeDeviceSessions } from "../socketServer";
import { requestEmailOtp, requestPhoneOtp, verifyEmailOtp, verifyPhoneOtp } from "../otpChallenge";
import { cancelDeletionIfPending, requestDeletion } from "../accountDeletion";
import { normalizeEmail } from "../util";

export const authRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-shaped: a leading '+', a non-zero first digit, then up to 14 more
// digits (matches the ITU E.164 15-digit-total cap) — same rule as
// routes/profile.ts's PHONE_REGEX.
const PHONE_REGEX = /^\+[1-9]\d{6,14}$/;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // matches the JWT's own 90d expiry (see signToken)

// deviceId/deviceName are optional in every login request; a JSON client
// omitting a field vs. explicitly sending null are both "not provided" as
// far as this API is concerned (e.g. the app's getDeviceName() legitimately
// returns null on some devices/simulators), so treat anything that isn't a
// non-empty string as absent rather than rejecting the request over it.
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Coarse brute-force/spam guard on top of otpChallenge.ts's real 60s resend
// cooldown — this just caps total requests per IP+identifier in a window.
const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${req.body?.email ?? ""}`,
});

const phoneOtpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${req.body?.phoneNumber ?? ""}`,
});

/** Step 1: user submits their email, we mail them a one-time code. */
authRouter.post("/otp/request", otpRequestLimiter, async (req, res) => {
  const { email } = req.body ?? {};

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }
  const normalizedEmail = normalizeEmail(email);

  const result = await requestEmailOtp(normalizedEmail);
  if ("error" in result) {
    res.status(429).json(result);
    return;
  }
  res.status(202).json({ ok: true });
});

/**
 * Step 2: user submits the code plus the device's freshly generated public
 * key. deviceId/deviceName are optional: a first-time login omits deviceId
 * and gets a newly registered device back in the response (which the
 * client is expected to persist and send on every subsequent login from
 * that same device); sending a previously-issued deviceId back reuses that
 * device's identity instead of registering a new one. Logging in with a
 * new deviceId links an additional device rather than logging any existing
 * one out — see issueSession below.
 */
authRouter.post("/otp/verify", async (req, res) => {
  const { email, code, publicKey } = req.body ?? {};
  const deviceId = optionalString(req.body?.deviceId);
  const deviceName = optionalString(req.body?.deviceName);

  if (typeof email !== "string" || typeof code !== "string" || typeof publicKey !== "string") {
    res.status(400).json({ error: "email, code and publicKey are required" });
    return;
  }
  const normalizedEmail = normalizeEmail(email);

  const verification = await verifyEmailOtp(normalizedEmail, code);
  if ("error" in verification) {
    const status = verification.error === "too_many_attempts" ? 429 : verification.error === "invalid_code" ? 401 : 400;
    res.status(status).json({ error: verification.error });
    return;
  }

  const { token, userId, deviceId: linkedDeviceId } = await issueSession(
    { email: normalizedEmail },
    publicKey,
    deviceId,
    deviceName
  );
  res.status(200).json({ token, userId, deviceId: linkedDeviceId });
});

/** Phone equivalent of /otp/request — sends via MSG91 (see sms.ts), stubbed to a console log until real credentials are configured. */
authRouter.post("/phone-otp/request", phoneOtpRequestLimiter, async (req, res) => {
  const { phoneNumber } = req.body ?? {};

  if (typeof phoneNumber !== "string" || !PHONE_REGEX.test(phoneNumber)) {
    res.status(400).json({ error: "invalid_phone_number" });
    return;
  }

  const result = await requestPhoneOtp(phoneNumber);
  if ("error" in result) {
    res.status(429).json(result);
    return;
  }
  res.status(202).json({ ok: true });
});

/** Phone equivalent of /otp/verify — same device-linking semantics as issueSession below, just keyed by contactNumber instead of email. */
authRouter.post("/phone-otp/verify", async (req, res) => {
  const { phoneNumber, code, publicKey } = req.body ?? {};
  const deviceId = optionalString(req.body?.deviceId);
  const deviceName = optionalString(req.body?.deviceName);

  if (typeof phoneNumber !== "string" || typeof code !== "string" || typeof publicKey !== "string") {
    res.status(400).json({ error: "phoneNumber, code and publicKey are required" });
    return;
  }

  const verification = await verifyPhoneOtp(phoneNumber, code);
  if ("error" in verification) {
    const status = verification.error === "too_many_attempts" ? 429 : verification.error === "invalid_code" ? 401 : 400;
    res.status(status).json({ error: verification.error });
    return;
  }

  const { token, userId, deviceId: linkedDeviceId } = await issueSession(
    { phoneNumber },
    publicKey,
    deviceId,
    deviceName
  );
  res.status(200).json({ token, userId, deviceId: linkedDeviceId });
});

/**
 * Upserts the user for this email-or-phone identity plus publicKey,
 * registers/refreshes the login device, and signs a fresh token. Shared by
 * both real OTP flows (email and phone) and the SKIP_OTP dev bypass below —
 * all three end in the same session state. Exactly one of
 * identity.email/identity.phoneNumber is ever set, matching the OtpChallenge
 * shape this is called after verifying.
 *
 * Re-authenticating on the SAME device (deviceId matches one already linked
 * to this account) replaces that device's own session; every other device
 * linked to the account is left running. That's what makes real concurrent
 * multi-device work — the only things that log out every device at once are
 * deleting the account (see accountDeletion.ts) or explicitly removing a
 * device from Settings (see routes/devices.ts).
 */
async function issueSession(
  identity: { email: string } | { phoneNumber: string },
  publicKey: string,
  deviceId?: string,
  deviceName?: string
): Promise<{ token: string; userId: string; deviceId: string }> {
  const where = "email" in identity ? { email: identity.email } : { contactNumber: identity.phoneNumber };

  let user: User;
  try {
    user = await prisma.user.upsert({
      where,
      update: { publicKey },
      create: { ...where, publicKey },
    });
  } catch {
    // Extremely rare race on the unique constraint (two concurrent
    // first-time verifications for the same identity) — the loser just
    // re-reads the row the winner created instead of surfacing an error
    // for what looks to the client like a normal login.
    const created = await prisma.user.findUnique({ where });
    if (!created) throw new Error("user upsert failed and no row was found after conflict");
    user = await prisma.user.update({ where: { id: created.id }, data: { publicKey } });
  }

  // A successful login cancels any pending account deletion — see
  // accountDeletion.ts. Harmless no-op if none was pending.
  await cancelDeletionIfPending(user.id);

  const device = await resolveLoginDevice(user.id, publicKey, deviceId, deviceName);

  await prisma.session.updateMany({
    where: { deviceId: device.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const session = await prisma.session.create({
    data: { userId: user.id, deviceId: device.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });

  await revokeDeviceSessions(device.id);

  return {
    token: signToken({ userId: user.id, sessionId: session.id, deviceId: device.id }),
    userId: user.id,
    deviceId: device.id,
  };
}

/**
 * Dev-only bypass so the OTP round trip (email or phone) doesn't have to be
 * exercised on every test login. Only active when SKIP_OTP=true — never
 * enable this in production, it's a full authentication bypass by design.
 */
if (process.env.SKIP_OTP === "true") {
  authRouter.post("/dev-login", async (req, res) => {
    const { email, phoneNumber, publicKey } = req.body ?? {};
    const deviceId = optionalString(req.body?.deviceId);
    const deviceName = optionalString(req.body?.deviceName);

    if (typeof publicKey !== "string") {
      res.status(400).json({ error: "publicKey is required" });
      return;
    }

    let identity: { email: string } | { phoneNumber: string };
    if (typeof email === "string" && EMAIL_REGEX.test(email)) {
      identity = { email: normalizeEmail(email) };
    } else if (typeof phoneNumber === "string" && PHONE_REGEX.test(phoneNumber)) {
      identity = { phoneNumber };
    } else {
      res.status(400).json({ error: "a valid email or phoneNumber is required" });
      return;
    }

    const { token, userId, deviceId: linkedDeviceId } = await issueSession(identity, publicKey, deviceId, deviceName);
    res.status(200).json({ token, userId, deviceId: linkedDeviceId });
  });
}

authRouter.get("/session", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });

  res.json({ userId: user!.id, email: user!.email, phoneNumber: user!.contactNumber });
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res) => {
  await prisma.session.update({
    where: { id: req.user!.sessionId },
    data: { revokedAt: new Date() },
  });
  res.status(204).end();
});

/**
 * Schedules the account for permanent deletion after ACCOUNT_DELETION_GRACE_MS
 * and revokes every device's session immediately, unlike a normal
 * device-scoped logout — deleting the account should sign you out
 * everywhere. Logging back in before the grace period elapses cancels the
 * deletion — see cancelDeletionIfPending in issueSession above.
 */
authRouter.post("/account/delete", requireAuth, async (req: AuthedRequest, res) => {
  const deletionScheduledFor = await requestDeletion(req.user!.userId);
  await revokeAllUserSessions(req.user!.userId);
  res.status(200).json({ ok: true, deletionScheduledFor });
});
