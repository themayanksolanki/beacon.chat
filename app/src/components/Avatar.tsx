import { useMemo } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

import { colorForName, initialFor, type ThemeColors } from "../theme";
import { useTheme } from "../ThemeContext";

export interface AvatarProps {
  name: string;
  avatarUrl: string | null;
  size?: number;
  /** Small online-status dot in the bottom-right corner, matching ChatHeaderTitle's presence indicator. */
  onlineDot?: boolean;
}

// Shared Image-or-initials pattern, previously duplicated independently in
// ChatHeaderTitle, ConversationRow, HeaderAvatarButton, and ContactInfoScreen.
export default function Avatar({ name, avatarUrl, size = 36, onlineDot = false }: AvatarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors, size), [colors, size]);

  return (
    <View style={styles.wrap}>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, { backgroundColor: colorForName(name) }]}>
          <Text style={styles.avatarText}>{initialFor(name)}</Text>
        </View>
      )}
      {onlineDot ? <View style={styles.onlineDot} /> : null}
    </View>
  );
}

const createStyles = (colors: ThemeColors, size: number) =>
  StyleSheet.create({
    wrap: { position: "relative" },
    avatar: {
      width: size,
      height: size,
      borderRadius: size / 2,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarText: { fontSize: Math.round(size * 0.39), fontWeight: "700", color: "#fff" },
    onlineDot: {
      position: "absolute",
      bottom: -1,
      right: -1,
      width: 11,
      height: 11,
      borderRadius: 5.5,
      backgroundColor: colors.tickRead,
      borderWidth: 2,
      borderColor: colors.surface,
    },
  });
