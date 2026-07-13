import { Directory, File, Paths } from "expo-file-system";

const VIDEO_DIR_NAME = "chat-videos";

function videoDirectory(): Directory {
  const dir = new Directory(Paths.document, VIDEO_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Copies a picked/captured video (living in a transient cache location) into permanent app storage, ahead of encrypt+upload. */
export async function persistPickedVideo(sourceUri: string, messageId: string): Promise<string> {
  const destination = new File(videoDirectory(), `${messageId}.mp4`);
  if (destination.exists) destination.delete();
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

/** Writes decrypted video bytes (downloaded from S3) to permanent storage. */
export function writeVideoMessageBytes(bytes: Uint8Array, messageId: string): string {
  const destination = new File(videoDirectory(), `${messageId}.mp4`);
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(bytes);
  return destination.uri;
}

export function readVideoMessageBase64(uri: string): string {
  return new File(uri).base64Sync();
}

export function deleteVideoMessage(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}
