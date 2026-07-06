export type ThemeColors = {
  accent: string;
  accentSoft: string;
  danger: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  surface: string;
  background: string;
  tabInactive: string;
  bubbleIncoming: string;
  tickRead: string;
};

export const lightColors: ThemeColors = {
  accent: "#007AFF",
  accentSoft: "#E8F1FF",
  danger: "#FF3B30",
  text: "#1C1C1E",
  textSecondary: "#6B7280",
  textTertiary: "#9CA3AF",
  border: "#E5E5EA",
  surface: "#FFFFFF",
  background: "#F2F2F7",
  tabInactive: "#8E8E93",
  bubbleIncoming: "#E9E9EB",
  tickRead: "#34C759",
};

export const darkColors: ThemeColors = {
  accent: "#0A84FF",
  accentSoft: "#132A46",
  danger: "#FF453A",
  text: "#F2F2F7",
  textSecondary: "#98989F",
  textTertiary: "#6E6E73",
  border: "#38383A",
  surface: "#1C1C1E",
  background: "#000000",
  tabInactive: "#8E8E93",
  bubbleIncoming: "#2C2C2E",
  tickRead: "#30D158",
};

const AVATAR_PALETTE = ["#FF6B6B", "#4ECDC4", "#556270", "#C77DFF", "#F7B32B", "#3A86FF", "#FF7BAC"];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

export function initialFor(name: string | null | undefined): string {
  return name?.trim().charAt(0).toUpperCase() || "?";
}
