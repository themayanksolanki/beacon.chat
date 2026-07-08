import { Directory, File, Paths } from "expo-file-system";

const VOICE_DIR_NAME = "voice-messages";

function voiceDirectory(): Directory {
  const dir = new Directory(Paths.document, VOICE_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** Copies a freshly recorded clip (living in a transient recorder-owned location) into permanent app storage. */
export async function persistRecordedVoice(sourceUri: string, messageId: string): Promise<string> {
  const destination = new File(voiceDirectory(), `${messageId}.m4a`);
  if (destination.exists) destination.delete();
  await new File(sourceUri).copy(destination);
  return destination.uri;
}

/** Writes base64 audio decoded from an incoming encrypted payload straight to permanent storage. */
export function writeVoiceMessageBase64(base64: string, messageId: string): string {
  const destination = new File(voiceDirectory(), `${messageId}.m4a`);
  if (destination.exists) destination.delete();
  destination.create({ overwrite: true });
  destination.write(base64, { encoding: "base64" });
  return destination.uri;
}

export function readVoiceMessageBase64(uri: string): string {
  return new File(uri).base64Sync();
}
