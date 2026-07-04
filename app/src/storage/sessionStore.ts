import * as SecureStore from "expo-secure-store";

const TOKEN_ALIAS = "beacon.session.token";

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
