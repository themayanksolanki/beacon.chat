import { File } from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";
import { Video } from "react-native-compressor";

import { MEDIA_COMPRESSION_CONFIG } from "./mediaCompressionConfig";

const { maxDimension, compressionMethod, skipBelowBytes, thumbnailTimeMs } = MEDIA_COMPRESSION_CONFIG.video;

export interface CompressedVideo {
  uri: string;
  width: number;
  height: number;
  /** Local poster-frame file, or null if generation failed — best-effort, never blocks a send. */
  thumbnailUri: string | null;
  skipped: boolean;
}

/**
 * Re-encodes a picked/captured video to H.264/AAC at up to 720p (via
 * react-native-compressor, whose defaults mirror WhatsApp's own compression
 * settings), then grabs a poster frame for the outgoing bubble. Skips
 * re-encoding for sources already under the configured threshold. The
 * library reports final size as a 0..1 progress fraction; it doesn't return
 * output dimensions, so those are derived the same way the source asset's
 * aspect ratio is scaled to maxDimension everywhere else in this file.
 */
export async function compressVideo(
  uri: string,
  originalWidth: number,
  originalHeight: number,
  callbacks?: {
    onProgress?: (fraction: number) => void;
    onThumbnailStart?: () => void;
  }
): Promise<CompressedVideo> {
  const sourceSize = new File(uri).size ?? 0;
  const shouldCompress = sourceSize === 0 || sourceSize > skipBelowBytes;

  let outUri = uri;
  let width = originalWidth;
  let height = originalHeight;

  if (shouldCompress) {
    outUri = await Video.compress(uri, { compressionMethod, maxSize: maxDimension }, (fraction) =>
      callbacks?.onProgress?.(fraction)
    );
    const longestEdge = Math.max(originalWidth, originalHeight) || 1;
    const scale = Math.min(1, maxDimension / longestEdge);
    width = Math.max(1, Math.round(originalWidth * scale));
    height = Math.max(1, Math.round(originalHeight * scale));
  } else {
    callbacks?.onProgress?.(1);
  }

  callbacks?.onThumbnailStart?.();
  const thumbnailUri = await generateThumbnail(outUri);

  return { uri: outUri, width, height, thumbnailUri, skipped: !shouldCompress };
}

async function generateThumbnail(uri: string): Promise<string | null> {
  try {
    const { uri: thumbUri } = await VideoThumbnails.getThumbnailAsync(uri, { time: thumbnailTimeMs });
    return thumbUri;
  } catch (err) {
    console.warn("[media] failed to generate video thumbnail", err);
    return null;
  }
}
