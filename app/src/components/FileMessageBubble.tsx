import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import type { MediaStatus } from "../db/database";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  fileName: string;
  mime: string | null;
  sizeBytes: number | null;
  isLocal: boolean;
  mediaStatus: MediaStatus;
  isSending: boolean;
  uploadProgress?: number;
  onDownload?: () => void;
  /** Opens an already-local file via the OS share/open sheet — mutually exclusive with onDownload (isLocal decides which one tapping the bubble triggers). */
  onOpen?: () => void;
  /** Forwarded to this Pressable directly rather than relying on bubbling to
   * a parent Pressable — a long-press starting here claims the touch
   * responder itself (it's the deepest Pressable), so without this the
   * parent MessageBubble's own onLongPress (the reply/copy/delete/pin menu)
   * never fired here, only on the bubble's border/padding. */
  onLongPress?: () => void;
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function FileMessageBubble({
  fileName,
  mime,
  sizeBytes,
  isLocal,
  mediaStatus,
  isSending,
  uploadProgress,
  onDownload,
  onOpen,
  onLongPress,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const icon = mime?.startsWith("audio/") ? "musical-notes-outline" : "document-outline";
  const inFlight = isSending || mediaStatus === "downloading";
  const canDownload = !isLocal && !inFlight && !!onDownload;
  const canOpen = isLocal && !inFlight && !!onOpen;

  return (
    // No background of its own — this renders inside MessageBubble's framed
    // (bordered, no solid fill) bubble now, same for outgoing and incoming,
    // so there's no more accent-vs-gray distinction to color icon/text for.
    <Pressable
      style={styles.container}
      onPress={canDownload ? onDownload : canOpen ? onOpen : undefined}
      onLongPress={onLongPress}
      disabled={!canDownload && !canOpen && !onLongPress}
    >
      <View style={styles.iconWrap}>
        {inFlight ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Ionicons name={icon} size={22} color={colors.textSecondary} />
        )}
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
          {fileName}
        </Text>
        <Text style={styles.meta}>
          {isSending && uploadProgress != null
            ? `Uploading ${Math.round(uploadProgress * 100)}%`
            : mediaStatus === "downloading"
              ? "Downloading…"
              : !isLocal
                ? `Tap to download${sizeBytes ? ` · ${formatSize(sizeBytes)}` : ""}`
                : canOpen
                  ? `Tap to open${sizeBytes ? ` · ${formatSize(sizeBytes)}` : ""}`
                  : formatSize(sizeBytes)}
        </Text>
      </View>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 12,
      minWidth: 180,
      maxWidth: 240,
    },
    iconWrap: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    textWrap: { flex: 1, minWidth: 0 },
    name: { color: colors.text, fontSize: 14, fontWeight: "600" },
    meta: { color: colors.textTertiary, fontSize: 11, marginTop: 2 },
  });
