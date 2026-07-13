import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";

import { WAVEFORM_BAR_COUNT } from "../audio/waveform";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_MAX_EXTRA_HEIGHT = 16;
// Fixed width sized for the widest realistic label ("99:59") so it never grows and
// pushes the waveform out of the row — the previous flex layout let a long recording's
// duration text steal width from the bars, and the bars themselves (fixed pixel widths)
// would then overflow past the bubble's rounded edge instead of shrinking to fit.
const DURATION_WIDTH = 34;

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

interface Props {
  audioUri: string | null;
  durationMs: number;
  waveform: number[];
  /** Forwarded to this Pressable directly rather than relying on bubbling to
   * a parent Pressable — a long-press starting here claims the touch
   * responder itself (it's the deepest Pressable), so without this the
   * parent MessageBubble's own onLongPress (the reply/copy/delete/pin menu)
   * never fired here, only on the bubble's border/padding. */
  onLongPress?: () => void;
}

export default function VoiceMessageBubble({ audioUri, durationMs, waveform, onLongPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const player = useAudioPlayer(audioUri ? { uri: audioUri } : null);
  const status = useAudioPlayerStatus(player);

  const totalSeconds = status.duration > 0 ? status.duration : durationMs / 1000;
  const progress = totalSeconds > 0 ? Math.min(1, status.currentTime / totalSeconds) : 0;
  const playedBars = Math.round(progress * waveform.length);
  const displaySeconds = status.playing ? status.currentTime : totalSeconds;

  const toggle = () => {
    if (!audioUri) return;
    if (status.playing) {
      player.pause();
      return;
    }
    if (totalSeconds > 0 && status.currentTime >= totalSeconds - 0.05) {
      player.seekTo(0);
    }
    player.play();
  };

  // No more outgoing/incoming distinction — this renders inside
  // MessageBubble's framed (bordered, no solid fill) bubble now, the same
  // neutral surface for both directions.
  const playedColor = colors.accent;
  const unplayedColor = colors.textTertiary;

  return (
    <Pressable
      style={styles.row}
      onPress={toggle}
      onLongPress={onLongPress}
      disabled={!audioUri && !onLongPress}
    >
      <Ionicons name={status.playing ? "pause-circle" : "play-circle"} size={30} color={colors.accent} />
      <View style={styles.waveform}>
        {waveform.map((amplitude, index) => (
          <View
            key={index}
            style={[
              styles.bar,
              {
                height: 3 + amplitude * BAR_MAX_EXTRA_HEIGHT,
                backgroundColor: index < playedBars ? playedColor : unplayedColor,
              },
            ]}
          />
        ))}
      </View>
      <Text style={styles.duration} numberOfLines={1}>
        {formatDuration(displaySeconds)}
      </Text>
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
    waveform: {
      flexDirection: "row",
      alignItems: "center",
      gap: BAR_GAP,
      height: 20,
      width: WAVEFORM_BAR_COUNT * BAR_WIDTH + (WAVEFORM_BAR_COUNT - 1) * BAR_GAP,
      overflow: "hidden",
    },
    bar: { width: BAR_WIDTH, borderRadius: BAR_WIDTH / 2 },
    duration: {
      fontSize: 11,
      width: DURATION_WIDTH,
      textAlign: "right",
      fontVariant: ["tabular-nums"],
      color: colors.textSecondary,
    },
  });
