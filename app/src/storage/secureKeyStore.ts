import * as SecureStore from "expo-secure-store";

import { sanitizeAccountKey } from "./accountKey";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// Keys are namespaced per account so two accounts signed into the same
// device get distinct keypairs — otherwise they'd share one identity and
// each could decrypt ciphertext addressed to the other's public key.
function aliasesFor(accountKey: string) {
  const key = sanitizeAccountKey(accountKey);
  return {
    publicKey: `beacon.identity.${key}.publicKey`,
    privateKey: `beacon.identity.${key}.privateKey`,
  };
}

export async function saveIdentityKeys(accountKey: string, publicKey: string, privateKey: string) {
  const alias = aliasesFor(accountKey);
  await SecureStore.setItemAsync(alias.publicKey, publicKey, secureOptions);
  await SecureStore.setItemAsync(alias.privateKey, privateKey, secureOptions);
}

export async function loadIdentityKeys(accountKey: string) {
  const alias = aliasesFor(accountKey);
  const [publicKey, privateKey] = await Promise.all([
    SecureStore.getItemAsync(alias.publicKey, secureOptions),
    SecureStore.getItemAsync(alias.privateKey, secureOptions),
  ]);
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

export async function clearIdentityKeys(accountKey: string) {
  const alias = aliasesFor(accountKey);
  await SecureStore.deleteItemAsync(alias.publicKey, secureOptions);
  await SecureStore.deleteItemAsync(alias.privateKey, secureOptions);
}
