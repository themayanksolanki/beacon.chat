const MIN_DB = -60;

/** Maps a dBFS metering reading to a 0..1 bar height, treating anything below MIN_DB as silence. */
export function normalizeMetering(db: number | undefined): number {
  if (typeof db !== "number" || !Number.isFinite(db)) return 0.05;
  const clamped = Math.max(MIN_DB, Math.min(0, db));
  return Math.max(0.05, (clamped - MIN_DB) / -MIN_DB);
}

export const WAVEFORM_BAR_COUNT = 28;

/** Downsamples a raw amplitude series (one sample per metering tick) to a fixed bar count for display. */
export function resampleWaveform(samples: number[], barCount: number = WAVEFORM_BAR_COUNT): number[] {
  if (samples.length === 0) return new Array(barCount).fill(0.08);
  if (samples.length <= barCount) return samples;

  const bucketSize = samples.length / barCount;
  const bars: number[] = [];
  for (let i = 0; i < barCount; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
    const bucket = samples.slice(start, end);
    bars.push(bucket.reduce((sum, v) => sum + v, 0) / bucket.length);
  }
  return bars;
}
