import { prisma } from "./prisma";
import { generateOtp, hashOtp, otpHashesMatch, MAX_ATTEMPTS, OTP_TTL_MS } from "./otp";
import { sendOtpEmail } from "./email";
import { sendOtpSms } from "./sms";

/**
 * Shared generate/hash/store/send/verify plumbing for every OTP challenge in
 * the app — email login, phone login, and the authenticated "add a missing
 * identifier" flows in routes/profile.ts. All four are the exact same shape,
 * just a different channel and a different thing done once the code checks
 * out, so that last part is left to each call site.
 */

export const RESEND_COOLDOWN_MS = 60 * 1000;

type Channel = "email" | "phone";

function whereFor(channel: Channel, identifier: string) {
  return channel === "email" ? { email: identifier } : { phone: identifier };
}

export type RequestOtpResult = { ok: true } | { error: "cooldown"; retryAfterSeconds: number };

async function requestChallenge(channel: Channel, identifier: string): Promise<RequestOtpResult> {
  const where = whereFor(channel, identifier);

  // A true resend cooldown (not just the count-based express-rate-limit
  // already in front of these routes) — checked against the most recent
  // challenge row regardless of whether it already expired, so a user can't
  // dodge the wait by just letting the old one expire first.
  const latest = await prisma.otpChallenge.findFirst({ where, orderBy: { createdAt: "desc" } });
  if (latest) {
    const elapsedMs = Date.now() - latest.createdAt.getTime();
    if (elapsedMs < RESEND_COOLDOWN_MS) {
      return { error: "cooldown", retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000) };
    }
  }

  // Opportunistic cleanup: otherwise every request leaves a row behind
  // forever, since nothing else ever deletes expired challenges.
  await prisma.otpChallenge.deleteMany({ where: { ...where, expiresAt: { lt: new Date() } } });

  const code = generateOtp();
  await prisma.otpChallenge.create({
    data: {
      ...where,
      codeHash: hashOtp(code, identifier),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      attempts: 0,
    },
  });

  if (channel === "email") {
    await sendOtpEmail(identifier, code);
  } else {
    await sendOtpSms(identifier, code);
  }

  return { ok: true };
}

export function requestEmailOtp(email: string): Promise<RequestOtpResult> {
  return requestChallenge("email", email);
}

export function requestPhoneOtp(phone: string): Promise<RequestOtpResult> {
  return requestChallenge("phone", phone);
}

export type VerifyOtpResult =
  | { ok: true }
  | { error: "otp_expired_or_not_found" | "too_many_attempts" | "invalid_code" };

async function verifyChallenge(channel: Channel, identifier: string, code: string): Promise<VerifyOtpResult> {
  const where = whereFor(channel, identifier);
  const challenge = await prisma.otpChallenge.findFirst({ where, orderBy: { createdAt: "desc" } });

  if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
    return { error: "otp_expired_or_not_found" };
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    return { error: "too_many_attempts" };
  }

  if (!otpHashesMatch(challenge.codeHash, hashOtp(code, identifier))) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    return { error: "invalid_code" };
  }

  await prisma.otpChallenge.deleteMany({ where });
  return { ok: true };
}

export function verifyEmailOtp(email: string, code: string): Promise<VerifyOtpResult> {
  return verifyChallenge("email", email, code);
}

export function verifyPhoneOtp(phone: string, code: string): Promise<VerifyOtpResult> {
  return verifyChallenge("phone", phone, code);
}
