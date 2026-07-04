import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

const FULL_NAME_ALIAS = "beacon.profile.fullName";
const PHOTO_URI_ALIAS = "beacon.profile.photoUri";
const CREATED_AT_ALIAS = "beacon.profile.createdAt";
const PROFILE_PHOTO_FILENAME = "profile-photo.jpg";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface Profile {
  fullName: string;
  photoUri: string | null;
  createdAt: number;
}

// The picker hands back a uri into a transient cache directory, so it's
// copied into the document directory to survive cache eviction and app restarts.
async function persistPhoto(sourceUri: string): Promise<string> {
  const destination = new File(Paths.document, PROFILE_PHOTO_FILENAME);
  if (destination.exists) {
    destination.delete();
  }
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

export async function saveProfile(fullName: string, sourcePhotoUri: string | null): Promise<Profile> {
  const photoUri = sourcePhotoUri ? await persistPhoto(sourcePhotoUri) : null;

  const existingCreatedAt = await SecureStore.getItemAsync(CREATED_AT_ALIAS, secureOptions);
  const createdAt = existingCreatedAt ? Number(existingCreatedAt) : Date.now();

  await SecureStore.setItemAsync(FULL_NAME_ALIAS, fullName, secureOptions);
  await SecureStore.setItemAsync(CREATED_AT_ALIAS, String(createdAt), secureOptions);
  if (photoUri) {
    await SecureStore.setItemAsync(PHOTO_URI_ALIAS, photoUri, secureOptions);
  } else {
    await SecureStore.deleteItemAsync(PHOTO_URI_ALIAS, secureOptions);
  }

  return { fullName, photoUri, createdAt };
}

export async function loadProfile(): Promise<Profile | null> {
  const fullName = await SecureStore.getItemAsync(FULL_NAME_ALIAS, secureOptions);
  if (!fullName) return null;

  const storedPhotoUri = await SecureStore.getItemAsync(PHOTO_URI_ALIAS, secureOptions);
  // The stored path lives under the app's Documents directory, which is
  // reassigned to a new container on reinstall — guard against pointing at
  // a path that no longer exists rather than rendering a broken image.
  const photoUri = storedPhotoUri && new File(storedPhotoUri).exists ? storedPhotoUri : null;

  const createdAt = await SecureStore.getItemAsync(CREATED_AT_ALIAS, secureOptions);
  return { fullName, photoUri, createdAt: createdAt ? Number(createdAt) : Date.now() };
}

export async function clearProfile(): Promise<void> {
  await SecureStore.deleteItemAsync(FULL_NAME_ALIAS, secureOptions);
  await SecureStore.deleteItemAsync(PHOTO_URI_ALIAS, secureOptions);
  await SecureStore.deleteItemAsync(CREATED_AT_ALIAS, secureOptions);
  const photo = new File(Paths.document, PROFILE_PHOTO_FILENAME);
  if (photo.exists) {
    photo.delete();
  }
}
