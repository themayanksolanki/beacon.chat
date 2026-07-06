import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

// Longest edge a sent photo is allowed to keep, and the JPEG quality it's
// re-encoded at — chat photos don't need to retain camera-original
// resolution, and keeping them small matters for the socket payload limit.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.6;

export interface CompressedImage {
  uri: string;
  width: number;
  height: number;
}

/** Downscales (never upscales) and re-encodes a picked/captured photo before it's persisted or sent. */
export async function compressImage(
  uri: string,
  originalWidth: number,
  originalHeight: number
): Promise<CompressedImage> {
  const longestEdge = Math.max(originalWidth, originalHeight);
  const scale = Math.min(1, MAX_DIMENSION / longestEdge);
  const targetWidth = Math.max(1, Math.round(originalWidth * scale));
  const targetHeight = Math.max(1, Math.round(originalHeight * scale));

  const context = ImageManipulator.manipulate(uri).resize({ width: targetWidth, height: targetHeight });
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });
  return { uri: saved.uri, width: saved.width, height: saved.height };
}
