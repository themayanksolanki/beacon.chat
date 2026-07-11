import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "./prisma";

const JWT_SECRET: string = (() => {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error("JWT_SECRET environment variable must be set");
  }
  return value;
})();

export interface TokenPayload {
  userId: string;
  sessionId: string;
  deviceId: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "90d", algorithm: "HS256" });
}

// Pin the algorithm rather than trusting the one in the token header —
// otherwise a forged token could pick e.g. "none" or switch HMAC/RSA in ways
// that defeat verification.
export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as unknown as TokenPayload;
}

/**
 * A valid JWT signature is not enough: the embedded sessionId must still
 * resolve to a live Session row for that same device. Re-logging in on the
 * SAME device revokes its own previous session (see issueSession in
 * routes/auth.ts); other devices linked to the account are untouched —
 * that's what makes concurrent multi-device work while still killing a
 * stolen/old token the moment its device re-authenticates or gets removed
 * from Settings.
 */
export async function isSessionActive(payload: TokenPayload): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: payload.sessionId } });

  if (!session || session.userId !== payload.userId || session.deviceId !== payload.deviceId) return false;
  if (session.revokedAt) return false;
  if (session.expiresAt.getTime() < Date.now()) return false;
  return true;
}

export interface AuthedRequest extends Request {
  user?: TokenPayload;
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    res.status(401).json({ error: "missing_token" });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  if (!(await isSessionActive(payload))) {
    res.status(401).json({ error: "session_revoked" });
    return;
  }

  req.user = payload;
  next();
}
