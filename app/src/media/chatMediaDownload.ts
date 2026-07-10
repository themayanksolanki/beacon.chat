import { Directory, File, Paths } from "expo-file-system";
import { decryptFileBytes } from "../crypto/fileCrypto";
import {
  setMessageFileLocal,
  setMessageImageLocal,
  setMessageMediaStatus,
  setMessageVideoLocal,
  type MessageRow,
} from "../db/database";
import { writeFileMessageBytes } from "./fileStorage";
import { writeImageMessageBytes } from "./imageStorage";
import { writeVideoMessageBytes } from "./videoStorage";

const DOWNLOAD_DIR_NAME = "chat-media-download";

function downloadDirectory(): Directory {
  const dir = new Directory(Paths.cache, DOWNLOAD_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Downloads an S3-backed attachment's ciphertext, decrypts it (see
 * crypto/fileCrypto.ts), and persists the plaintext locally via the
 * kind-specific storage module — mirrors the write side of the legacy
 * inline-base64 image path, just sourced from a network download instead of
 * the message payload itself. Only touches SQLite/the filesystem; callers
 * (MessagingContext for auto-download, ChatScreen for tap-to-download/retry)
 * are responsible for refreshing any in-memory message list afterward.
 */
export async function fetchAndStoreChatMedia(message: MessageRow): Promise<void> {
  if (!message.media_url || !message.media_key || !message.media_nonce) return;
  if (message.kind !== "image" && message.kind !== "video" && message.kind !== "file") return;

  setMessageMediaStatus(message.id, "downloading");
  try {
    const destination = new File(downloadDirectory(), `${message.id}.enc`);
    if (destination.exists) destination.delete();
    await File.downloadFileAsync(message.media_url, destination, { idempotent: true });

    const ciphertext = destination.bytesSync();
    const plaintext = await decryptFileBytes(ciphertext, message.media_key, message.media_nonce);
    destination.delete();

    if (message.kind === "image") {
      setMessageImageLocal(message.id, writeImageMessageBytes(plaintext, message.id));
    } else if (message.kind === "video") {
      setMessageVideoLocal(message.id, writeVideoMessageBytes(plaintext, message.id));
    } else {
      setMessageFileLocal(message.id, writeFileMessageBytes(plaintext, message.id, message.file_name ?? "file"));
    }
  } catch (err) {
    console.warn("[chatMediaDownload] failed to fetch/decrypt media", message.id, err);
    setMessageMediaStatus(message.id, "download_failed");
    throw err;
  }
}
