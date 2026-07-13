import { Directory, File, Paths } from "expo-file-system";

const FILE_DIR_NAME = "chat-files";

function fileDirectory(): Directory {
  const dir = new Directory(Paths.document, FILE_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

// Keep the original extension on the stored copy so the OS/players can infer
// content type from the local file (mime type itself travels in the
// encrypted payload's file_mime field, not the filename).
function extensionOf(originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  return dot >= 0 ? originalName.slice(dot) : "";
}

/** Copies a picked document/audio file (living in a transient cache location) into permanent app storage, ahead of encrypt+upload. */
export async function persistPickedFile(sourceUri: string, messageId: string, originalName: string): Promise<string> {
  const destination = new File(fileDirectory(), `${messageId}${extensionOf(originalName)}`);
  if (destination.exists) destination.delete();
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

/** Writes decrypted file bytes (downloaded from S3) to permanent storage. */
export function writeFileMessageBytes(bytes: Uint8Array, messageId: string, originalName: string): string {
  const destination = new File(fileDirectory(), `${messageId}${extensionOf(originalName)}`);
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(bytes);
  return destination.uri;
}

export function readFileMessageBase64(uri: string): string {
  return new File(uri).base64Sync();
}

export function deleteFileMessage(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}
