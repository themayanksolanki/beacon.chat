import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const { AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env;

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

let client: S3Client | null = null;

/** Profile-avatar objects live in S3; if unset, avatar uploads are disabled
 * but name-only profile updates still work (see routes/profile.ts). */
export function isS3Configured(): boolean {
  return Boolean(AWS_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
}

function s3(): S3Client {
  if (!client) {
    if (!isS3Configured()) {
      throw new Error("s3_not_configured");
    }
    client = new S3Client({
      region: AWS_REGION,
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID!, secretAccessKey: AWS_SECRET_ACCESS_KEY! },
    });
  }
  return client;
}

export function buildAvatarKey(userId: string): string {
  return `avatars/${userId}/${randomUUID()}.jpg`;
}

export function publicAvatarUrl(key: string): string {
  return `https://${AWS_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

/** Presigned POST policy: S3 itself enforces the content-type/size
 * conditions at upload time, and the key prefix scopes the upload to this
 * user (defense in depth against a client requesting/forging another
 * user's key is re-checked server-side on PUT /profile). */
export async function createAvatarUploadPost(
  userId: string
): Promise<{ url: string; fields: Record<string, string>; key: string }> {
  const key = buildAvatarKey(userId);
  const { url, fields } = await createPresignedPost(s3(), {
    Bucket: AWS_S3_BUCKET!,
    Key: key,
    Conditions: [
      ["starts-with", "$key", `avatars/${userId}/`],
      ["starts-with", "$Content-Type", "image/"],
      ["content-length-range", 1, MAX_AVATAR_BYTES],
    ],
    Fields: { "Content-Type": "image/jpeg" },
    Expires: 300,
  });
  return { url, fields, key };
}

export async function headAvatarObject(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET!, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: failures are logged, never thrown, so a delete hiccup can't
 * block a profile save or account purge. */
export async function deleteAvatarObject(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET!, Key: key }));
  } catch (err) {
    console.warn("[s3] failed to delete avatar object", key, err);
  }
}
