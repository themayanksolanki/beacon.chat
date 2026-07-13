import * as SecureStore from "expo-secure-store";

const TOKEN_ALIAS = "beacon.session.token";
// Alias name predates phone login (accounts were email-only then, so this
// used to hold a bare email string) — kept as-is so existing installs don't
// lose their cached value on update. Now holds a small JSON blob (see
// CachedIdentity); loadCachedIdentity() below falls back to treating an
// un-parseable value as a legacy email-only entry.
const IDENTITY_ALIAS = "beacon.session.email";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface CachedIdentity {
  // Stable per-device key namespacing local chat DB/profile/identity
  // storage (see AuthContext's establishSession) — fixed the first time this
  // device establishes a session and never recomputed after, even once the
  // account has both identifiers (e.g. a phone-only signup that later adds
  // an email from Account still keys local storage off the phone number).
  accountKey: string;
  email: string | null;
  phoneNumber: string | null;
}

export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_ALIAS, token, secureOptions);
}

export async function loadSessionToken() {
  return SecureStore.getItemAsync(TOKEN_ALIAS, secureOptions);
}

export async function clearSessionToken() {
  await SecureStore.deleteItemAsync(TOKEN_ALIAS, secureOptions);
}

// Cached so the app can stay signed in (and show the right identity) from a
// valid local token even when the startup session check can't reach the
// server (see AuthContext).
export async function saveCachedIdentity(identity: CachedIdentity) {
  await SecureStore.setItemAsync(IDENTITY_ALIAS, JSON.stringify(identity), secureOptions);
}

export async function loadCachedIdentity(): Promise<CachedIdentity | null> {
  const raw = await SecureStore.getItemAsync(IDENTITY_ALIAS, secureOptions);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accountKey === "string") return parsed as CachedIdentity;
  } catch {
    // Pre-phone-login installs stored a bare email string here.
  }
  return { accountKey: raw, email: raw, phoneNumber: null };
}

export async function clearCachedIdentity() {
  await SecureStore.deleteItemAsync(IDENTITY_ALIAS, secureOptions);
}
