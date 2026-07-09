import { File, UploadType } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import type { AvatarUploadTarget } from "./client";

const MAX_DIMENSION = 1024;
// Keep in sync with the server's MAX_AVATAR_BYTES (server/src/s3.ts) — this
// is a fail-fast client-side check; S3's POST policy enforces the real limit.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export class AvatarTooLargeError extends Error {}

// Resizes/re-encodes the picked photo (already square-cropped by the
// picker) to a bounded JPEG so uploads stay small and consistent.
export async function prepareAvatarForUpload(photoUri: string): Promise<string> {
  const rendered = await ImageManipulator.manipulate(photoUri)
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION })
    .renderAsync();
  const result = await rendered.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });

  if (new File(result.uri).size > MAX_AVATAR_BYTES) {
    throw new AvatarTooLargeError("Photo is too large; choose a smaller image.");
  }
  return result.uri;
}

// Uploads directly to S3 using the presigned POST policy fields returned by
// POST /profile/avatar/upload-url — the file never transits the app server.
export async function uploadAvatarToS3(target: AvatarUploadTarget, photoUri: string): Promise<void> {
  const result = await new File(photoUri).upload(target.url, {
    httpMethod: "POST",
    uploadType: UploadType.MULTIPART,
    fieldName: "file",
    mimeType: "image/jpeg",
    parameters: target.fields,
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`avatar_upload_failed_${result.status}`);
  }
}
