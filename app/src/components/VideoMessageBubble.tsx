import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";

import type { MediaStatus } from "../db/database";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

const MAX_WIDTH = 220;
const MAX_HEIGHT = 260;
const MIN_SIZE = 120;

interface Props {
  videoUri: string | null;
  width: number;
  height: number;
  durationMs: number;
  sizeBytes: number | null;
  mediaStatus: MediaStatus;
  isSending: boolean;
  uploadProgress?: number;
  onDownload?: () => void;
  onCancelSend?: () => void;
  /** Opens the video full-screen to actually play it (see MediaViewerModal)
   * — the in-bubble thumbnail is a static, non-interactive preview frame. */
  onExpand?: () => void;
  /** Forwarded to this Pressable directly rather than relying on bubbling to
   * a parent Pressable — a long-press starting on this thumbnail claims the
   * touch responder itself (it's the deepest Pressable), so without this the
   * parent MessageBubble's own onLongPress (the reply/copy/delete/pin menu)
   * never fired here, only on the bubble's border/padding. */
  onLongPress?: () => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Video is never auto-downloaded (unlike image/file) given files can be up
// to 100MB — this renders a tap-to-download placeholder until video_uri is
// populated (see media/chatMediaDownload.ts), then a real player once local.
export default function VideoMessageBubble({
  videoUri,
  width,
  height,
  durationMs,
  sizeBytes,
  mediaStatus,
  isSending,
  uploadProgress,
  onDownload,
  onCancelSend,
  onExpand,
  onLongPress,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  let displayWidth = MAX_WIDTH;
  let displayHeight = displayWidth / aspect;
  if (displayHeight > MAX_HEIGHT) {
    displayHeight = MAX_HEIGHT;
    displayWidth = displayHeight * aspect;
  }
  displayWidth = Math.max(MIN_SIZE, displayWidth);
  displayHeight = Math.max(MIN_SIZE, displayHeight);

  // Always called (never conditionally) — the player just holds a null
  // source until videoUri is populated by a completed download.
  const player = useVideoPlayer(videoUri ?? null);

  const containerStyle = [styles.container, { width: displayWidth, height: displayHeight }];

  if (videoUri) {
    return (
      <Pressable
        style={containerStyle}
        onPress={!isSending ? onExpand : undefined}
        onLongPress={onLongPress}
        disabled={!onExpand && !onLongPress}
      >
        <VideoView player={player} style={styles.video} nativeControls={false} contentFit="cover" />
        {!isSending ? (
          <>
            <View style={styles.playOverlay} pointerEvents="none">
              <Ionicons name="play-circle" size={44} color="rgba(255,255,255,0.9)" />
            </View>
            <View style={styles.durationBadge} pointerEvents="none">
              <Text style={styles.durationText}>{formatDuration(durationMs)}</Text>
            </View>
          </>
        ) : null}
        {isSending ? (
          <View style={styles.overlay} pointerEvents="box-none">
            <ActivityIndicator color="#fff" />
            {uploadProgress != null ? (
              <Text style={styles.overlayText}>{Math.round(uploadProgress * 100)}%</Text>
            ) : null}
            {onCancelSend ? (
              <Pressable style={styles.cancelButton} onPress={onCancelSend} hitSlop={8}>
                <Ionicons name="close" size={16} color="#fff" />
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    );
  }

  return (
    <Pressable
      style={containerStyle}
      onPress={mediaStatus === "downloading" ? undefined : onDownload}
      onLongPress={mediaStatus === "downloading" ? undefined : onLongPress}
      disabled={mediaStatus === "downloading" && !onLongPress}
    >
      <View style={[styles.video, styles.placeholder]}>
        {mediaStatus === "downloading" ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : (
          <>
            <Ionicons name="play-circle-outline" size={36} color={colors.textTertiary} />
            <Text style={styles.placeholderText}>
              Tap to download{sizeBytes ? ` (${formatSize(sizeBytes)})` : ""}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      borderRadius: 14,
      overflow: "hidden",
      backgroundColor: colors.bubbleIncoming,
    },
    video: { width: "100%", height: "100%" },
    placeholder: { alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 10 },
    placeholderText: { fontSize: 12, color: colors.textTertiary, textAlign: "center" },
    overlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0,0,0,0.35)",
      alignItems: "center",
      justifyContent: "center",
    },
    overlayText: { color: "#fff", fontSize: 12, fontWeight: "700", marginTop: 6 },
    cancelButton: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: "rgba(0,0,0,0.55)",
      alignItems: "center",
      justifyContent: "center",
    },
    durationBadge: {
      position: "absolute",
      bottom: 6,
      right: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 6,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    durationText: { color: "#fff", fontSize: 11, fontWeight: "700" },
    playOverlay: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      justifyContent: "center",
    },
  });
