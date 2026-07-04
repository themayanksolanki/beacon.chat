import { Router } from "express";
import { db } from "../db";
import { requireAuth } from "../auth";

export const usersRouter = Router();

interface UserRow {
  id: string;
  phone_number: string;
  public_key: string | null;
}

const MAX_LOOKUP_NUMBERS = 500;

usersRouter.get("/by-phone/:phoneNumber/public-key", requireAuth, (req, res) => {
  const phoneNumber = String(req.params.phoneNumber);
  const user = db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE phone_number = ?")
    .get(phoneNumber);

  if (!user || !user.public_key) {
    res.status(404).json({ error: "user not found" });
    return;
  }

  res.json({ userId: user.id, publicKey: user.public_key });
});

/**
 * Bulk contact-matching lookup: the app sends every phone number from the
 * device's address book and gets back only the ones registered on Beacon
 * (with a public key, i.e. they've completed OTP verification at least
 * once). Used to distinguish "chat" vs "invite" in the Contacts screen.
 */
usersRouter.post("/lookup", requireAuth, (req, res) => {
  const { phoneNumbers } = req.body ?? {};

  if (!Array.isArray(phoneNumbers) || phoneNumbers.some((p) => typeof p !== "string")) {
    res.status(400).json({ error: "phoneNumbers must be an array of strings" });
    return;
  }

  const unique = [...new Set(phoneNumbers)].slice(0, MAX_LOOKUP_NUMBERS);
  if (unique.length === 0) {
    res.json({ matches: [] });
    return;
  }

  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare<string[], UserRow>(
      `SELECT id, phone_number, public_key FROM users WHERE phone_number IN (${placeholders}) AND public_key IS NOT NULL`
    )
    .all(...unique);

  res.json({
    matches: rows.map((r) => ({ phoneNumber: r.phone_number, userId: r.id, publicKey: r.public_key })),
  });
});
