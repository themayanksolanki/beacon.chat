import { File, Paths } from "expo-file-system";
import { StorageAccessFramework } from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// Android only: Android's Storage Access Framework is the only way to get a
// real, user-visible "Beacon/Audio", "Beacon/Video", "Beacon/Photos",
// "Beacon/Documents" folder tree that holds arbitrary file types (including
// documents) under one shared root — expo-media-library's album API is
// scoped to the OS's separate Pictures/Movies/Music collections and has no
// generic "documents" collection, so it can't produce this layout. iOS has
// no equivalent of a single custom shared folder tree; this module is a
// no-op there (isDownloadAvailable() reports it, callers should hide the
// "Save" action accordingly rather than needing a separate iOS path today).
export type MediaCategory = "Audio" | "Video" | "Photos" | "Documents";

const CATEGORIES: MediaCategory[] = ["Audio", "Video", "Photos", "Documents"];
const ROOT_FOLDER_NAME = "Beacon";

const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const ROOT_URI_ALIAS = "beacon.download.rootUri";
const categoryUriAlias = (category: MediaCategory) => `beacon.download.categoryUri.${category}`;

/**
 * SAF's createDirectory doesn't enforce unique display names — calling
 * makeDirectoryAsync again on every save would pile up duplicate "Beacon"
 * folders — so look for an existing child directory by display name first.
 * NOTE: matches on the last decoded path segment of each child's SAF URI;
 * this is a best-effort heuristic (SAF has no dedicated "list with metadata"
 * call available here) and is worth double-checking on a real Android
 * device/provider before shipping.
 */
async function findChildDirectory(parentUri: string, name: string): Promise<string | null> {
  try {
    const children = await StorageAccessFramework.readDirectoryAsync(parentUri);
    return children.find((uri) => decodeURIComponent(uri).split("/").pop() === name) ?? null;
  } catch (err) {
    console.warn("[download] failed to list directory", err);
    return null;
  }
}

async function ensureChildDirectory(parentUri: string, name: string): Promise<string> {
  const existing = await findChildDirectory(parentUri, name);
  if (existing) return existing;
  return StorageAccessFramework.makeDirectoryAsync(parentUri, name);
}

export function isDownloadAvailable(): boolean {
  return Platform.OS === "android";
}

/**
 * Sets up <user-chosen root>/Beacon/{Audio,Video,Photos,Documents}. This is
 * what "asking permission before downloading" means on Android: the OS's own
 * folder picker *is* the permission grant, shown once — the chosen root and
 * every category folder's URI are cached, so later saves never prompt again.
 * Video/Documents are created up front even though no message kind produces
 * that content yet, so the structure is already there when that's added.
 */
export async function ensureDownloadFolders(): Promise<boolean> {
  if (!isDownloadAvailable()) return false;

  let rootUri = await SecureStore.getItemAsync(ROOT_URI_ALIAS, secureOptions);
  if (!rootUri) {
    const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!result.granted) return false;
    rootUri = result.directoryUri;
    await SecureStore.setItemAsync(ROOT_URI_ALIAS, rootUri, secureOptions);
  }

  const beaconUri = await ensureChildDirectory(rootUri, ROOT_FOLDER_NAME);
  for (const category of CATEGORIES) {
    const alias = categoryUriAlias(category);
    if (await SecureStore.getItemAsync(alias, secureOptions)) continue;
    const categoryUri = await ensureChildDirectory(beaconUri, category);
    await SecureStore.setItemAsync(alias, categoryUri, secureOptions);
  }
  return true;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_") || "file";
}

export interface SaveMediaInput {
  category: MediaCategory;
  /** Without extension — the created SAF file's extension comes from mimeType. */
  fileName: string;
  mimeType: string;
  base64: string;
}

export type SaveMediaError = "unsupported_platform" | "permission_denied" | "save_failed";
export type SaveMediaResult = { ok: true } | { ok: false; error: SaveMediaError };

/** Saves already-base64-encoded content into the matching Beacon/<category> folder. */
export async function saveMediaToDevice(input: SaveMediaInput): Promise<SaveMediaResult> {
  if (!isDownloadAvailable()) return { ok: false, error: "unsupported_platform" };

  const granted = await ensureDownloadFolders();
  if (!granted) return { ok: false, error: "permission_denied" };

  const categoryUri = await SecureStore.getItemAsync(categoryUriAlias(input.category), secureOptions);
  if (!categoryUri) return { ok: false, error: "save_failed" };

  try {
    const fileUri = await StorageAccessFramework.createFileAsync(
      categoryUri,
      sanitizeFileName(input.fileName),
      input.mimeType
    );
    await StorageAccessFramework.writeAsStringAsync(fileUri, input.base64, { encoding: "base64" });
    return { ok: true };
  } catch (err) {
    console.warn("[download] failed to save media", err);
    return { ok: false, error: "save_failed" };
  }
}

/** Downloads a remote url (e.g. a GIPHY CDN gif) to a throwaway cache file and returns its base64 content. */
export async function base64FromRemoteUrl(url: string): Promise<string> {
  const tempFile = await File.downloadFileAsync(url, Paths.cache);
  try {
    return tempFile.base64Sync();
  } finally {
    if (tempFile.exists) tempFile.delete();
  }
}
