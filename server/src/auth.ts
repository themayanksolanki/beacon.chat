import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";
import { users } from "./schema";

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
 * match the user's current_session_id. Logging in on another device
 * overwrites that column, which is what makes the old device's token stop
 * working immediately instead of only expiring after 90 days.
 */
export function isSessionActive(payload: TokenPayload): boolean {
  const user = db
    .select({ id: users.id, current_session_id: users.current_session_id })
    .from(users)
    .where(eq(users.id, payload.userId))
    .get();

  return user?.current_session_id === payload.sessionId;
}

export interface AuthedRequest extends Request {
  user?: TokenPayload;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
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

  if (!isSessionActive(payload)) {
    res.status(401).json({ error: "session_revoked" });
    return;
  }

  req.user = payload;
  next();
}
