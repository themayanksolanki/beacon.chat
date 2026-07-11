import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
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

// Scoped per account, same as the identity keypair above: if this physical
// device ever signs into a second account, that's a separate device
// registration from the server's point of view too (each Device row belongs
// to exactly one user), so it needs its own id rather than reusing the
// first account's.
function deviceIdAliasFor(accountKey: string): string {
  return `beacon.device.${sanitizeAccountKey(accountKey)}.id`;
}

/**
 * Loads this account's persisted deviceId, generating one the first time it
 * signs into this device. Sent on every login (see AuthContext) so the
 * server can recognize "this is the same device logging in again" and
 * replace just that device's session instead of registering a new device —
 * see server/src/devices.ts:resolveLoginDevice.
 */
export async function getOrCreateDeviceId(accountKey: string): Promise<string> {
  const alias = deviceIdAliasFor(accountKey);
  const existing = await SecureStore.getItemAsync(alias, secureOptions);
  if (existing) return existing;

  const deviceId = Crypto.randomUUID();
  await SecureStore.setItemAsync(alias, deviceId, secureOptions);
  return deviceId;
}

// Re-saves whatever deviceId the server actually assigned/echoed back after
// a login — normally identical to what getOrCreateDeviceId already
// persisted, but keeps the two in sync in the rare case the server had to
// fall back to a different id (see resolveLoginDevice's collision handling).
export async function saveDeviceId(accountKey: string, deviceId: string) {
  await SecureStore.setItemAsync(deviceIdAliasFor(accountKey), deviceId, secureOptions);
}

export async function clearDeviceId(accountKey: string) {
  await SecureStore.deleteItemAsync(deviceIdAliasFor(accountKey), secureOptions);
}

/** A human-readable label for the device list in Settings, e.g. "Mayank's iPhone". */
export function getDeviceName(): string | null {
  return Device.deviceName ?? null;
}
