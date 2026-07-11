import type { CallPhase } from "./CallContext";

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function statusText(phase: CallPhase | string, durationSec: number): string {
  if (phase === "outgoing-ringing") return "Calling…";
  if (phase === "connecting") return "Connecting…";
  if (phase === "connected") return formatDuration(durationSec);
  return "";
}
