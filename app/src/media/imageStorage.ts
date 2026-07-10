import { Directory, File, Paths } from "expo-file-system";

const IMAGE_DIR_NAME = "chat-images";

function imageDirectory(): Directory {
  const dir = new Directory(Paths.document, IMAGE_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Copies an already-compressed image (living in a transient cache location) into permanent app storage. */
export async function persistPickedImage(sourceUri: string, messageId: string): Promise<string> {
  const destination = new File(imageDirectory(), `${messageId}.jpg`);
  if (destination.exists) destination.delete();
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

/** Writes base64 image data decoded from an incoming encrypted payload straight to permanent storage. */
export function writeImageMessageBase64(base64: string, messageId: string): string {
  const destination = new File(imageDirectory(), `${messageId}.jpg`);
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(base64, { encoding: "base64" });
  return destination.uri;
}

/** Writes decrypted image bytes (downloaded from S3 via the new attachment pipeline) to permanent storage. */
export function writeImageMessageBytes(bytes: Uint8Array, messageId: string): string {
  const destination = new File(imageDirectory(), `${messageId}.jpg`);
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(bytes);
  return destination.uri;
}

export function readImageMessageBase64(uri: string): string {
  return new File(uri).base64Sync();
}

export function deleteImageMessage(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}
