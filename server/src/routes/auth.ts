import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { otpChallenges, users } from "../schema";
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

type UserRow = typeof users.$inferSelect;
type OtpChallengeRow = typeof otpChallenges.$inferSelect;

/** Step 1: user submits their email, we mail them a one-time code. */
authRouter.post("/otp/request", otpRequestLimiter, async (req, res) => {
  const { email } = req.body ?? {};

  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    res.status(400).json({ error: "invalid_email" });
    return;
  }

  // Opportunistic cleanup: otherwise every request leaves a row behind
  // forever, since nothing else ever deletes expired challenges.
  db.delete(otpChallenges)
    .where(and(eq(otpChallenges.email, email), lt(otpChallenges.expires_at, Date.now())))
    .run();

  const code = generateOtp();
  db.insert(otpChallenges)
    .values({
      id: randomUUID(),
      email,
      code_hash: hashOtp(code, email),
      expires_at: Date.now() + OTP_TTL_MS,
      attempts: 0,
      created_at: Date.now(),
    })
    .run();

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

  const challenge: OtpChallengeRow | undefined = db
    .select()
    .from(otpChallenges)
    .where(eq(otpChallenges.email, email))
    .orderBy(desc(otpChallenges.created_at))
    .limit(1)
    .get();

  if (!challenge || challenge.expires_at < Date.now()) {
    res.status(400).json({ error: "otp_expired_or_not_found" });
    return;
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    res.status(429).json({ error: "too_many_attempts" });
    return;
  }

  if (!otpHashesMatch(challenge.code_hash, hashOtp(code, email))) {
    db.update(otpChallenges)
      .set({ attempts: challenge.attempts + 1 })
      .where(eq(otpChallenges.id, challenge.id))
      .run();
    res.status(401).json({ error: "invalid_code" });
    return;
  }

  db.delete(otpChallenges).where(eq(otpChallenges.email, email)).run();

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
  let user: UserRow | undefined = db.select().from(users).where(eq(users.email, email)).get();

  if (user) {
    db.update(users)
      .set({ public_key: publicKey, current_session_id: sessionId })
      .where(eq(users.id, user.id))
      .run();
  } else {
    const id = randomUUID();
    db.insert(users)
      .values({
        id,
        email,
        public_key: publicKey,
        current_session_id: sessionId,
        created_at: Date.now(),
        last_seen_at: null,
      })
      .run();
    user = { id, email, public_key: publicKey, current_session_id: sessionId, created_at: Date.now(), last_seen_at: null };
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
  const user = db.select().from(users).where(eq(users.id, req.user!.userId)).get();

  res.json({ userId: user!.id, email: user!.email });
});

authRouter.post("/logout", requireAuth, (req: AuthedRequest, res) => {
  db.update(users).set({ current_session_id: null }).where(eq(users.id, req.user!.userId)).run();
  res.status(204).end();
});
