import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import Avatar from "./Avatar";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  name: string;
  avatarUrl: string | null;
  /** Opens the shared contact's chat — undefined when there's nothing local to open (e.g. no conversation with them yet). */
  onPress?: () => void;
  onLongPress?: () => void;
}

export default function ContactMessageBubble({ name, avatarUrl, onPress, onLongPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Pressable style={styles.container} onPress={onPress} onLongPress={onLongPress} disabled={!onPress}>
      <Avatar name={name} avatarUrl={avatarUrl} size={40} />
      <View style={styles.textWrap}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.meta}>Contact</Text>
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} /> : null}
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
      minWidth: 190,
      maxWidth: 240,
    },
    textWrap: { flex: 1, minWidth: 0 },
    name: { color: colors.text, fontSize: 14, fontWeight: "600" },
    meta: { color: colors.textTertiary, fontSize: 11, marginTop: 2 },
  });
