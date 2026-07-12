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
  isOutgoing: boolean;
  uploadProgress?: number;
  onDownload?: () => void;
  /** Forwarded to this Pressable directly rather than relying on bubbling to
   * a parent Pressable — a long-press starting here claims the touch
   * responder itself (it's the deepest Pressable), so without this the
   * parent MessageBubble's own onLongPress (the reply/copy/delete/pin menu)
   * never fired here, only on the bubble's border/padding. */
  onLongPress?: () => void;
}

function formatSize(bytes: number | null): string {
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
  isOutgoing,
  uploadProgress,
  onDownload,
  onLongPress,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const icon = mime?.startsWith("audio/") ? "musical-notes-outline" : "document-outline";
  const inFlight = isSending || mediaStatus === "downloading";
  const canDownload = !isLocal && !inFlight && !!onDownload;

  return (
    <Pressable
      style={[styles.container, isOutgoing ? styles.outgoing : styles.incoming]}
      onPress={canDownload ? onDownload : undefined}
      onLongPress={onLongPress}
      disabled={!canDownload && !onLongPress}
    >
      <View style={styles.iconWrap}>
        {inFlight ? (
          <ActivityIndicator size="small" color={isOutgoing ? "#fff" : colors.textSecondary} />
        ) : (
          <Ionicons name={icon} size={22} color={isOutgoing ? "#fff" : colors.textSecondary} />
        )}
      </View>
      <View style={styles.textWrap}>
        <Text
          style={isOutgoing ? styles.nameOutgoing : styles.nameIncoming}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {fileName}
        </Text>
        <Text style={isOutgoing ? styles.metaOutgoing : styles.metaIncoming}>
          {isSending && uploadProgress != null
            ? `Uploading ${Math.round(uploadProgress * 100)}%`
            : mediaStatus === "downloading"
              ? "Downloading…"
              : !isLocal
                ? `Tap to download${sizeBytes ? ` · ${formatSize(sizeBytes)}` : ""}`
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
    outgoing: { backgroundColor: "rgba(255,255,255,0.15)" },
    incoming: { backgroundColor: colors.bubbleIncoming },
    iconWrap: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
    textWrap: { flex: 1, minWidth: 0 },
    nameOutgoing: { color: "#fff", fontSize: 14, fontWeight: "600" },
    nameIncoming: { color: colors.text, fontSize: 14, fontWeight: "600" },
    metaOutgoing: { color: "rgba(255,255,255,0.75)", fontSize: 11, marginTop: 2 },
    metaIncoming: { color: colors.textTertiary, fontSize: 11, marginTop: 2 },
  });
