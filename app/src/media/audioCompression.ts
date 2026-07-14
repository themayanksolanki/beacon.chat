import { File } from "expo-file-system";
import { Audio } from "react-native-compressor";

import { MEDIA_COMPRESSION_CONFIG } from "./mediaCompressionConfig";

const { bitrate, skipBelowBytes } = MEDIA_COMPRESSION_CONFIG.audio;

export interface CompressedAudio {
  uri: string;
  skipped: boolean;
}

/**
 * Re-encodes a recorded voice note down to a low, speech-appropriate AAC
 * bitrate before it's persisted/sent inline (voice notes go out as base64
 * over the E2E channel, not through the S3 pipeline, so smaller here means
 * a smaller encrypted payload). Skips sources already under the configured
 * threshold — most voice notes are already this small.
 */
export async function compressAudio(uri: string): Promise<CompressedAudio> {
  const sourceSize = new File(uri).size ?? 0;
  if (sourceSize > 0 && sourceSize <= skipBelowBytes) {
    return { uri, skipped: true };
  }

  const compressedUri = await Audio.compress(uri, { bitrate });
  return { uri: compressedUri, skipped: false };
}
