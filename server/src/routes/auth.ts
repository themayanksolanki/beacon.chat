import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { requireAuth, signToken, type AuthedRequest } from "../auth";
import { revokeOtherSessions } from "../socketServer";
import { generateOtp, hashOtp, MAX_ATTEMPTS, OTP_TTL_MS } from "../otp";
import { sendOtpSms } from "../sms";

export const authRouter = Router();

const PHONE_REGEX = /^\+[1-9]\d{7,14}$/;

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${req.body?.phoneNumber ?? ""}`,
});

interface UserRow {
  id: string;
  phone_number: string;
  public_key: string | null;
  current_session_id: string | null;
}

interface OtpChallengeRow {
  id: string;
  phone_number: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
}

/** Step 1: user submits their phone number, we text them a one-time code. */
authRouter.post("/otp/request", otpRequestLimiter, async (req, res) => {
  const { phoneNumber } = req.body ?? {};

  if (typeof phoneNumber !== "string" || !PHONE_REGEX.test(phoneNumber)) {
    res.status(400).json({ error: "invalid_phone_number" });
    return;
  }

  const code = generateOtp();
  db.prepare(
    "INSERT INTO otp_challenges (id, phone_number, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(randomUUID(), phoneNumber, hashOtp(code, phoneNumber), Date.now() + OTP_TTL_MS, Date.now());

  await sendOtpSms(phoneNumber, code);
  res.status(202).json({ ok: true });
});

/**
 * Step 2: user submits the code plus the device's freshly generated
 * public key. On success this becomes the one active session for the
 * account — any other device gets logged out.
 */
authRouter.post("/otp/verify", async (req, res) => {
  const { phoneNumber, code, publicKey } = req.body ?? {};

  if (
    typeof phoneNumber !== "string" ||
    typeof code !== "string" ||
    typeof publicKey !== "string"
  ) {
    res.status(400).json({ error: "phoneNumber, code and publicKey are required" });
    return;
  }

  const challenge = db
    .prepare<[string], OtpChallengeRow>(
      "SELECT * FROM otp_challenges WHERE phone_number = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(phoneNumber);

  if (!challenge || challenge.expires_at < Date.now()) {
    res.status(400).json({ error: "otp_expired_or_not_found" });
    return;
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    res.status(429).json({ error: "too_many_attempts" });
    return;
  }

  if (challenge.code_hash !== hashOtp(code, phoneNumber)) {
    db.prepare("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?").run(challenge.id);
    res.status(401).json({ error: "invalid_code" });
    return;
  }

  db.prepare("DELETE FROM otp_challenges WHERE phone_number = ?").run(phoneNumber);

  const sessionId = randomUUID();
  let user = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE phone_number = ?")
    .get(phoneNumber);

  if (user) {
    db.prepare(
      "UPDATE users SET public_key = ?, current_session_id = ? WHERE id = ?"
    ).run(publicKey, sessionId, user.id);
  } else {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO users (id, phone_number, public_key, current_session_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, phoneNumber, publicKey, sessionId, Date.now());
    user = { id, phone_number: phoneNumber, public_key: publicKey, current_session_id: sessionId };
  }

  await revokeOtherSessions(user.id);

  const token = signToken({ userId: user.id, sessionId });
  res.status(200).json({ token, userId: user.id });
});

authRouter.get("/session", requireAuth, (req: AuthedRequest, res) => {
  const user = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
    .get(req.user!.userId);

  res.json({ userId: user!.id, phoneNumber: user!.phone_number });
});

authRouter.post("/logout", requireAuth, (req: AuthedRequest, res) => {
  db.prepare("UPDATE users SET current_session_id = NULL WHERE id = ?").run(req.user!.userId);
  res.status(204).end();
});
