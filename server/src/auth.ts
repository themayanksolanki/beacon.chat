import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";

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
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "90d" });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as unknown as TokenPayload;
}

interface UserRow {
  id: string;
  current_session_id: string | null;
}

/**
 * A valid JWT signature is not enough: the embedded sessionId must still
 * match the user's current_session_id. Logging in on another device
 * overwrites that column, which is what makes the old device's token stop
 * working immediately instead of only expiring after 90 days.
 */
export function isSessionActive(payload: TokenPayload): boolean {
  const user = db
    .prepare<[string], UserRow>("SELECT id, current_session_id FROM users WHERE id = ?")
    .get(payload.userId);

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
