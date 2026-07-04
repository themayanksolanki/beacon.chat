import * as SecureStore from "expo-secure-store";

const PRIVATE_KEY_ALIAS = "beacon.identity.privateKey";
const PUBLIC_KEY_ALIAS = "beacon.identity.publicKey";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function saveIdentityKeys(publicKey: string, privateKey: string) {
  await SecureStore.setItemAsync(PUBLIC_KEY_ALIAS, publicKey, secureOptions);
  await SecureStore.setItemAsync(PRIVATE_KEY_ALIAS, privateKey, secureOptions);
}

export async function loadIdentityKeys() {
  const [publicKey, privateKey] = await Promise.all([
    SecureStore.getItemAsync(PUBLIC_KEY_ALIAS, secureOptions),
    SecureStore.getItemAsync(PRIVATE_KEY_ALIAS, secureOptions),
  ]);
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

export async function clearIdentityKeys() {
  await SecureStore.deleteItemAsync(PUBLIC_KEY_ALIAS, secureOptions);
  await SecureStore.deleteItemAsync(PRIVATE_KEY_ALIAS, secureOptions);
}
