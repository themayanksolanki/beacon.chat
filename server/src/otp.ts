import { createHash, randomInt } from "node:crypto";

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const OTP_PEPPER: string = (() => {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error("JWT_SECRET environment variable must be set");
  }
  return value;
})();

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(code: string, email: string): string {
  return createHash("sha256").update(`${OTP_PEPPER}:${email}:${code}`).digest("hex");
}

export { OTP_TTL_MS, MAX_ATTEMPTS };
