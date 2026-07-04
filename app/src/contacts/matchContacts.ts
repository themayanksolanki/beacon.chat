import * as Contacts from "expo-contacts/legacy";

import { lookupUsers } from "../api/client";

export interface MatchedContact {
  id: string;
  name: string;
  email: string;
  registered: boolean;
  userId?: string;
  publicKey?: string;
}

function normalize(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Reads the device address book, normalizes every email address (trim +
 * lowercase), then asks the server which of those addresses are
 * registered. Contacts with no email are dropped rather than guessed at.
 */
export async function loadMatchedContacts(token: string, ownEmail: string): Promise<MatchedContact[]> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== "granted") {
    throw new Error("contacts_permission_denied");
  }

  const normalizedOwnEmail = normalize(ownEmail);

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.Emails],
  });

  const entries = data
    .filter((contact) => contact.name && contact.emails?.length)
    .map((contact) => {
      const normalized = contact.emails!
        .map((e) => (e.email ? normalize(e.email) : null))
        .find((e): e is string => !!e);
      return { id: contact.id ?? contact.name!, name: contact.name!, normalized };
    })
    .filter((entry): entry is typeof entry & { normalized: string } => !!entry.normalized)
    .filter((entry) => entry.normalized !== normalizedOwnEmail);

  const emailsToLookup = [...new Set(entries.map((e) => e.normalized))];
  const matches = emailsToLookup.length ? await lookupUsers(token, emailsToLookup) : [];
  const matchByEmail = new Map(matches.map((m) => [m.email, m]));

  return entries
    .map((entry) => {
      const match = matchByEmail.get(entry.normalized);
      return {
        id: entry.id,
        name: entry.name,
        email: entry.normalized,
        registered: !!match,
        userId: match?.userId,
        publicKey: match?.publicKey,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
