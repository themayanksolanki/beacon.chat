import * as Contacts from "expo-contacts/legacy";

import { lookupUsers, lookupUsersByPhone } from "../api/client";
import { DEFAULT_COUNTRY } from "../constants/countryCodes";

export interface MatchedContact {
  id: string;
  name: string;
  // Either or both may be set, depending on what the device contact (or
  // manual search) actually has — a registered match can come from either
  // channel (see loadMatchedContacts).
  email?: string;
  phoneNumber?: string;
  registered: boolean;
  userId?: string;
  publicKey?: string;
  avatarUrl?: string | null;
}

export function normalize(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Best-effort E.164 normalization for a device contact's raw phone number,
 * which may be formatted with spaces/dashes/parens and may or may not
 * already include a country code. A number with no country code is assumed
 * to be in this device's own default country — the same heuristic
 * WhatsApp-style contact sync relies on, since expo-contacts doesn't expose
 * the device's own region. Returns null if the result still isn't a
 * plausible phone number (matches the server's own PHONE_REGEX shape).
 */
function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (!digits.startsWith("+")) digits = `+${DEFAULT_COUNTRY.dialCode}${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

/** Looks up a single manually-typed email, for the "add by email" flow. */
export async function lookupSingleEmail(token: string, email: string): Promise<MatchedContact> {
  const normalized = normalize(email);
  const [match] = await lookupUsers(token, [normalized]);

  return {
    id: normalized,
    name: match?.name ?? normalized,
    email: normalized,
    registered: !!match,
    userId: match?.userId,
    publicKey: match?.publicKey,
    avatarUrl: match?.avatarUrl,
  };
}

/**
 * Reads the device address book, normalizes every phone number and email
 * address, then asks the server which are registered. Phone is checked
 * alongside email (not instead of it) — most address-book contacts have a
 * number but not everyone has an email on file, and some registered
 * accounts are email-only, so either channel can produce a match for the
 * same contact.
 */
export async function loadMatchedContacts(
  token: string,
  ownEmail: string | null,
  ownPhone: string | null
): Promise<MatchedContact[]> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== "granted") {
    throw new Error("contacts_permission_denied");
  }

  const normalizedOwnEmail = ownEmail ? normalize(ownEmail) : null;

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers],
  });

  const entries = data
    .filter((contact) => contact.name)
    .map((contact) => {
      const phones = [
        ...new Set(
          (contact.phoneNumbers ?? [])
            .map((p) => (p.number ? normalizePhone(p.number) : null))
            .filter((p): p is string => !!p && p !== ownPhone)
        ),
      ];
      const emails = [
        ...new Set(
          (contact.emails ?? [])
            .map((e) => (e.email ? normalize(e.email) : null))
            .filter((e): e is string => !!e && e !== normalizedOwnEmail)
        ),
      ];
      return { id: contact.id ?? contact.name!, name: contact.name!, phones, emails };
    })
    .filter((entry) => entry.phones.length > 0 || entry.emails.length > 0);

  const phonesToLookup = [...new Set(entries.flatMap((e) => e.phones))];
  const emailsToLookup = [...new Set(entries.flatMap((e) => e.emails))];

  const [phoneMatches, emailMatches] = await Promise.all([
    phonesToLookup.length ? lookupUsersByPhone(token, phonesToLookup) : Promise.resolve([]),
    emailsToLookup.length ? lookupUsers(token, emailsToLookup) : Promise.resolve([]),
  ]);

  const matchByPhone = new Map(phoneMatches.map((m) => [m.phoneNumber, m]));
  const matchByEmail = new Map(emailMatches.map((m) => [m.email, m]));

  return entries
    .map((entry) => {
      const match =
        entry.phones.map((p) => matchByPhone.get(p)).find((m) => m) ??
        entry.emails.map((e) => matchByEmail.get(e)).find((m) => m);

      return {
        id: entry.id,
        name: entry.name,
        email: entry.emails[0],
        phoneNumber: entry.phones[0],
        registered: !!match,
        userId: match?.userId,
        publicKey: match?.publicKey,
        avatarUrl: match?.avatarUrl,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
