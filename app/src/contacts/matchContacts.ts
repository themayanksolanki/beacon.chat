import * as Contacts from "expo-contacts/legacy";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

import { lookupUsers } from "../api/client";

export interface MatchedContact {
  id: string;
  name: string;
  phoneNumber: string;
  registered: boolean;
  userId?: string;
  publicKey?: string;
}

function normalize(raw: string, defaultCountry?: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Reads the device address book, normalizes every phone number to E.164
 * (assuming the signed-in user's own country for numbers with no country
 * code), then asks the server which of those numbers are registered.
 * Numbers that can't be parsed are dropped rather than guessed at.
 */
export async function loadMatchedContacts(
  token: string,
  ownPhoneNumber: string
): Promise<MatchedContact[]> {
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== "granted") {
    throw new Error("contacts_permission_denied");
  }

  const ownCountry = parsePhoneNumberFromString(ownPhoneNumber)?.country;

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.PhoneNumbers],
  });

  const entries = data
    .filter((contact) => contact.name && contact.phoneNumbers?.length)
    .map((contact) => {
      const normalized = contact.phoneNumbers!
        .map((p) => (p.number ? normalize(p.number, ownCountry) : null))
        .find((n): n is string => !!n);
      return { id: contact.id ?? contact.name!, name: contact.name!, normalized };
    })
    .filter((entry): entry is typeof entry & { normalized: string } => !!entry.normalized)
    .filter((entry) => entry.normalized !== ownPhoneNumber);

  const numbersToLookup = [...new Set(entries.map((e) => e.normalized))];
  const matches = numbersToLookup.length ? await lookupUsers(token, numbersToLookup) : [];
  const matchByPhone = new Map(matches.map((m) => [m.phoneNumber, m]));

  return entries
    .map((entry) => {
      const match = matchByPhone.get(entry.normalized);
      return {
        id: entry.id,
        name: entry.name,
        phoneNumber: entry.normalized,
        registered: !!match,
        userId: match?.userId,
        publicKey: match?.publicKey,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
