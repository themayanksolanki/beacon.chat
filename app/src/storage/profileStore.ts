import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { sanitizeAccountKey } from "./accountKey";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface Profile {
  fullName: string;
  photoUri: string | null;
  // Optional, self-reported, unverified. Kept alongside name/photo so the
  // edit-profile screen has something to prefill; the server (not this
  // local copy) is the source of truth for add-contact search.
  phoneNumber: string | null;
  createdAt: number;
}

// Storage is namespaced per account so a second account signing into this
// device doesn't inherit (or clobber) the first account's saved name/photo.
function aliasesFor(accountKey: string) {
  const key = sanitizeAccountKey(accountKey);
  return {
    fullName: `beacon.profile.${key}.fullName`,
    photoUri: `beacon.profile.${key}.photoUri`,
    phoneNumber: `beacon.profile.${key}.phoneNumber`,
    createdAt: `beacon.profile.${key}.createdAt`,
    photoFilename: `profile-photo-${key}.jpg`,
  };
}

// The picker hands back a uri into a transient cache directory, so it's
// copied into the document directory to survive cache eviction and app restarts.
async function persistPhoto(sourceUri: string, photoFilename: string): Promise<string> {
  const destination = new File(Paths.document, photoFilename);
  if (destination.exists) {
    destination.delete();
  }
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

export async function saveProfile(
  accountKey: string,
  fullName: string,
  sourcePhotoUri: string | null
): Promise<Profile> {
  const alias = aliasesFor(accountKey);
  const photoUri = sourcePhotoUri ? await persistPhoto(sourcePhotoUri, alias.photoFilename) : null;

  const existingCreatedAt = await SecureStore.getItemAsync(alias.createdAt, secureOptions);
  const createdAt = existingCreatedAt ? Number(existingCreatedAt) : Date.now();

  await SecureStore.setItemAsync(alias.fullName, fullName, secureOptions);
  await SecureStore.setItemAsync(alias.createdAt, String(createdAt), secureOptions);
  if (photoUri) {
    await SecureStore.setItemAsync(alias.photoUri, photoUri, secureOptions);
  } else {
    await SecureStore.deleteItemAsync(alias.photoUri, secureOptions);
  }

  // Phone number isn't touched by this function (it's saved separately via
  // savePhoneNumber) — just read it back so the returned Profile reflects
  // whatever's currently stored, instead of silently reporting it as unset.
  const phoneNumber = await SecureStore.getItemAsync(alias.phoneNumber, secureOptions);

  return { fullName, photoUri, phoneNumber: phoneNumber ?? null, createdAt };
}

export async function savePhoneNumber(accountKey: string, phoneNumber: string | null): Promise<void> {
  const alias = aliasesFor(accountKey);
  if (phoneNumber) {
    await SecureStore.setItemAsync(alias.phoneNumber, phoneNumber, secureOptions);
  } else {
    await SecureStore.deleteItemAsync(alias.phoneNumber, secureOptions);
  }
}

export async function loadProfile(accountKey: string): Promise<Profile | null> {
  const alias = aliasesFor(accountKey);
  const fullName = await SecureStore.getItemAsync(alias.fullName, secureOptions);
  if (!fullName) return null;

  const storedPhotoUri = await SecureStore.getItemAsync(alias.photoUri, secureOptions);
  // The stored path lives under the app's Documents directory, which is
  // reassigned to a new container on reinstall — guard against pointing at
  // a path that no longer exists rather than rendering a broken image.
  const photoUri = storedPhotoUri && new File(storedPhotoUri).exists ? storedPhotoUri : null;

  const phoneNumber = await SecureStore.getItemAsync(alias.phoneNumber, secureOptions);
  const createdAt = await SecureStore.getItemAsync(alias.createdAt, secureOptions);
  return {
    fullName,
    photoUri,
    phoneNumber: phoneNumber ?? null,
    createdAt: createdAt ? Number(createdAt) : Date.now(),
  };
}

export async function clearProfile(accountKey: string): Promise<void> {
  const alias = aliasesFor(accountKey);
  await SecureStore.deleteItemAsync(alias.fullName, secureOptions);
  await SecureStore.deleteItemAsync(alias.photoUri, secureOptions);
  await SecureStore.deleteItemAsync(alias.phoneNumber, secureOptions);
  await SecureStore.deleteItemAsync(alias.createdAt, secureOptions);
  const photo = new File(Paths.document, alias.photoFilename);
  if (photo.exists) {
    photo.delete();
  }
}
