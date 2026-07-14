import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

import { MEDIA_COMPRESSION_CONFIG } from "./mediaCompressionConfig";

const { maxWidth, maxHeight, quality, skipBelowBytes } = MEDIA_COMPRESSION_CONFIG.image;

export interface CompressedImage {
  uri: string;
  width: number;
  height: number;
  /** True if the source was already under skipBelowBytes and returned untouched. */
  skipped: boolean;
}

/**
 * Downscales (never upscales) and re-encodes a picked/captured photo before
 * it's persisted or sent. Skips re-encoding entirely for sources already
 * under the configured threshold — recompressing an already-small photo only
 * burns CPU/battery for no real size win.
 *
 * expo-image-manipulator's resize+renderAsync+saveAsync pipeline already
 * satisfies "strip EXIF, keep orientation" for free: it reads the source
 * respecting its EXIF orientation tag (so the output pixels are already
 * right-side-up) but never copies EXIF metadata into the re-encoded JPEG.
 */
export async function compressImage(
  uri: string,
  originalWidth: number,
  originalHeight: number
): Promise<CompressedImage> {
  const sourceSize = new File(uri).size ?? 0;
  if (sourceSize > 0 && sourceSize <= skipBelowBytes) {
    return { uri, width: originalWidth, height: originalHeight, skipped: true };
  }

  const longestEdge = Math.max(originalWidth, originalHeight);
  const maxDimension = Math.min(maxWidth, maxHeight);
  const scale = Math.min(1, maxDimension / longestEdge);
  const targetWidth = Math.max(1, Math.round(originalWidth * scale));
  const targetHeight = Math.max(1, Math.round(originalHeight * scale));

  const context = ImageManipulator.manipulate(uri).resize({ width: targetWidth, height: targetHeight });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ compress: quality, format: SaveFormat.JPEG });
  return { uri: saved.uri, width: saved.width, height: saved.height, skipped: false };
}
