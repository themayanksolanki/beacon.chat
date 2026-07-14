// Central, tunable knobs for client-side media compression — see
// imageCompression.ts / videoCompression.ts / audioCompression.ts. Keep every
// number that affects compressed output quality/size here rather than inline
// in each compressor, so retuning doesn't mean hunting across files.
export const MEDIA_COMPRESSION_CONFIG = {
  image: {
    maxWidth: 1920,
    maxHeight: 1920,
    quality: 0.8,
    // Below this, re-encoding buys nothing worth the CPU/battery cost (and
    // can occasionally end up larger than an already-small/lossy source).
    skipBelowBytes: 500 * 1024,
  },
  video: {
    // Longest edge a compressed video is downscaled to — "720p for large
    // videos" from the spec; react-native-compressor's own H.264/AAC
    // pipeline mirrors WhatsApp's compression settings at this size.
    maxDimension: 720,
    compressionMethod: "auto" as const,
    skipBelowBytes: 8 * 1024 * 1024,
    thumbnailTimeMs: 0,
  },
  audio: {
    // 64 kbps — top of the 32-64kbps voice-note range recommended for
    // AAC/Opus speech content.
    bitrate: 64000,
    skipBelowBytes: 150 * 1024,
  },
} as const;
