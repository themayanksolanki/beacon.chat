import { Directory, File, Paths, UploadType } from "expo-file-system";
import { requestChatMediaUploadUrl, type ChatMediaKind } from "../api/client";
import { encryptFileBytes } from "../crypto/fileCrypto";

export class ChatMediaTooLargeError extends Error {}
export class ChatMediaUploadUnavailableError extends Error {}

// Keep in sync with server/src/s3.ts's MAX_CHAT_*_BYTES — this is a
// fail-fast client-side check; the presigned POST's content-length-range
// enforces the real limit.
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;

export function maxBytesForChatMediaKind(kind: ChatMediaKind): number {
  return kind === "image" ? MAX_CHAT_IMAGE_BYTES : kind === "video" ? MAX_CHAT_VIDEO_BYTES : MAX_CHAT_FILE_BYTES;
}

export interface PreparedChatMedia {
  ciphertextUri: string;
  keyB64: string;
  nonceB64: string;
  /** Plaintext byte size — for the payload's `size` metadata field (display purposes only; the ciphertext transmitted is a little larger). */
  plaintextSize: number;
}

const UPLOAD_DIR_NAME = "chat-media-upload";

function uploadDirectory(): Directory {
  const dir = new Directory(Paths.cache, UPLOAD_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Reads sourceUri's raw bytes and encrypts them (see crypto/fileCrypto.ts),
 * writing only the ciphertext to a transient cache location keyed by
 * messageId — so a killed-app retry (see ChatScreen's onRetry) can re-upload
 * without re-reading or re-encrypting the original file.
 */
export async function encryptFileForUpload(
  sourceUri: string,
  messageId: string,
  maxBytes: number
): Promise<PreparedChatMedia> {
  const source = new File(sourceUri);
  if (source.size > maxBytes) {
    throw new ChatMediaTooLargeError(`File is too large (${source.size} bytes, limit ${maxBytes}).`);
  }

  const plaintext = source.bytesSync();
  const { ciphertext, keyB64, nonceB64 } = await encryptFileBytes(plaintext);

  const destination = new File(uploadDirectory(), `${messageId}.bin`);
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(ciphertext);

  return { ciphertextUri: destination.uri, keyB64, nonceB64, plaintextSize: source.size };
}

/**
 * Uploads the already-encrypted ciphertext to S3 via a presigned POST
 * (mirrors api/avatarUpload.ts's uploadAvatarToS3, but as a cancellable/
 * progress-reporting task since attachments can be far larger than avatars).
 */
export async function uploadChatMedia(
  token: string,
  messageId: string,
  kind: ChatMediaKind,
  prepared: PreparedChatMedia,
  onProgress?: (fraction: number) => void
): Promise<{ publicUrl: string }> {
  let target;
  try {
    target = await requestChatMediaUploadUrl(token, messageId, kind);
  } catch (err) {
    throw new ChatMediaUploadUnavailableError(
      err instanceof Error ? err.message : "chat_media_upload_unavailable"
    );
  }

  const task = new File(prepared.ciphertextUri).createUploadTask(target.url, {
    httpMethod: "POST",
    uploadType: UploadType.MULTIPART,
    fieldName: "file",
    mimeType: "application/octet-stream",
    parameters: target.fields,
    onProgress: (data) => {
      if (data.totalBytes > 0) onProgress?.(data.bytesSent / data.totalBytes);
    },
  });

  const result = await task.uploadAsync();
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`chat_media_upload_failed_${result.status}`);
  }

  return { publicUrl: target.publicUrl };
}

export function deletePendingChatMediaCiphertext(messageId: string): void {
  const file = new File(uploadDirectory(), `${messageId}.bin`);
  if (file.exists) file.delete();
}
