import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { requireAuth, signToken, type AuthedRequest } from "../auth";
import { revokeOtherSessions } from "../socketServer";
import { generateOtp, hashOtp, otpHashesMatch, MAX_ATTEMPTS, OTP_TTL_MS } from "../otp";
import { sendOtpEmail } from "../email";

export const authRouter = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${req.body?.email ?? ""}`,
});

interface UserRow {
  id: string;
  email: string;
  public_key: string | null;
  current_session_id: string | null;
}

interface OtpChallengeRow {
  id: string;
  email: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
}

/** Step 1: user submits their email, we mail them a one-time code. */
authRouter.post("/otp/request", otpRequestLimiter, async (req, res) => {
  const { email } = req.body ?? {};

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  // Opportunistic cleanup: otherwise every request leaves a row behind
  // forever, since nothing else ever deletes expired challenges.
  db.prepare("DELETE FROM otp_challenges WHERE email = ? AND expires_at < ?").run(email, Date.now());

  const code = generateOtp();
  db.prepare(
    "INSERT INTO otp_challenges (id, email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(randomUUID(), email, hashOtp(code, email), Date.now() + OTP_TTL_MS, Date.now());

  await sendOtpEmail(email, code);
  res.status(202).json({ ok: true });
});

/**
 * Step 2: user submits the code plus the device's freshly generated
 * public key. On success this becomes the one active session for the
 * account — any other device gets logged out.
 */
authRouter.post("/otp/verify", async (req, res) => {
  const { email, code, publicKey } = req.body ?? {};

  if (typeof email !== "string" || typeof code !== "string" || typeof publicKey !== "string") {
    res.status(400).json({ error: "email, code and publicKey are required" });
    return;
  }

  const challenge = db
    .prepare<[string], OtpChallengeRow>(
      "SELECT * FROM otp_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(email);

  if (!challenge || challenge.expires_at < Date.now()) {
    res.status(400).json({ error: "otp_expired_or_not_found" });
    return;
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    res.status(429).json({ error: "too_many_attempts" });
    return;
  }

  if (!otpHashesMatch(challenge.code_hash, hashOtp(code, email))) {
    db.prepare("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?").run(challenge.id);
    res.status(401).json({ error: "invalid_code" });
    return;
  }

  db.prepare("DELETE FROM otp_challenges WHERE email = ?").run(email);

  const { token, userId } = await issueSession(email, publicKey);
  res.status(200).json({ token, userId });
});

/**
 * Upserts the user for this email/publicKey, revokes any other active
 * session, and signs a fresh token. Shared by the real OTP flow and the
 * SKIP_OTP dev bypass below — both end in the same session state.
 */
async function issueSession(email: string, publicKey: string): Promise<{ token: string; userId: string }> {
  const sessionId = randomUUID();
  let user = db.prepare<[string], UserRow>("SELECT * FROM users WHERE email = ?").get(email);

  if (user) {
    db.prepare("UPDATE users SET public_key = ?, current_session_id = ? WHERE id = ?").run(
      publicKey,
      sessionId,
      user.id
    );
  } else {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO users (id, email, public_key, current_session_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, email, publicKey, sessionId, Date.now());
    user = { id, email, public_key: publicKey, current_session_id: sessionId };
  }

  await revokeOtherSessions(user.id);

  return { token: signToken({ userId: user.id, sessionId }), userId: user.id };
}

/**
 * Dev-only bypass so the OTP email round trip doesn't have to be exercised
 * on every test login. Only active when SKIP_OTP=true — never enable this
 * in production, it's a full authentication bypass by design.
 */
if (process.env.SKIP_OTP === "true") {
  authRouter.post("/dev-login", async (req, res) => {
    const { email, publicKey } = req.body ?? {};

    if (typeof email !== "string" || !EMAIL_REGEX.test(email) || typeof publicKey !== "string") {
      res.status(400).json({ error: "email and publicKey are required" });
      return;
    }

    const { token, userId } = await issueSession(email, publicKey);
    res.status(200).json({ token, userId });
  });
}

authRouter.get("/session", requireAuth, (req: AuthedRequest, res) => {
  const user = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
    .get(req.user!.userId);

  res.json({ userId: user!.id, email: user!.email });
});

authRouter.post("/logout", requireAuth, (req: AuthedRequest, res) => {
  db.prepare("UPDATE users SET current_session_id = NULL WHERE id = ?").run(req.user!.userId);
  res.status(204).end();
});
