import { useMemo } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

const MAX_WIDTH = 220;
const MAX_HEIGHT = 260;
const MIN_SIZE = 120;

interface Props {
  imageUri: string | null;
  width: number;
  height: number;
  isSending: boolean;
  onCancelSend?: () => void;
  onPress?: () => void;
}

export default function ImageMessageBubble({ imageUri, width, height, isSending, onCancelSend, onPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const aspect = width > 0 && height > 0 ? width / height : 1;
  let displayWidth = MAX_WIDTH;
  let displayHeight = displayWidth / aspect;
  if (displayHeight > MAX_HEIGHT) {
    displayHeight = MAX_HEIGHT;
    displayWidth = displayHeight * aspect;
  }
  displayWidth = Math.max(MIN_SIZE, displayWidth);
  displayHeight = Math.max(MIN_SIZE, displayHeight);

  return (
    <Pressable
      style={[styles.container, { width: displayWidth, height: displayHeight }]}
      onPress={onPress}
      disabled={!onPress}
    >
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.image} />
      ) : (
        <View style={[styles.image, styles.placeholder]}>
          <Ionicons name="image-outline" size={28} color={colors.textTertiary} />
        </View>
      )}
      {isSending ? (
        <View style={styles.overlay}>
          <ActivityIndicator color="#fff" />
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

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      borderRadius: 14,
      overflow: "hidden",
      backgroundColor: colors.bubbleIncoming,
    },
    image: { width: "100%", height: "100%" },
    placeholder: { alignItems: "center", justifyContent: "center" },
    overlay: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0,0,0,0.35)",
      alignItems: "center",
      justifyContent: "center",
    },
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
  });
