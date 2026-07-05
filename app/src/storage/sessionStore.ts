import * as SecureStore from "expo-secure-store";

const TOKEN_ALIAS = "beacon.session.token";
const EMAIL_ALIAS = "beacon.session.email";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_ALIAS, token, secureOptions);
}

export async function loadSessionToken() {
  return SecureStore.getItemAsync(TOKEN_ALIAS, secureOptions);
}

export async function clearSessionToken() {
  await SecureStore.deleteItemAsync(TOKEN_ALIAS, secureOptions);
}

// Cached so the app can stay signed in from a valid local token even when
// the startup session check can't reach the server (see AuthContext).
export async function saveSessionEmail(email: string) {
  await SecureStore.setItemAsync(EMAIL_ALIAS, email, secureOptions);
}

export async function loadSessionEmail() {
  return SecureStore.getItemAsync(EMAIL_ALIAS, secureOptions);
}

export async function clearSessionEmail() {
  await SecureStore.deleteItemAsync(EMAIL_ALIAS, secureOptions);
}
