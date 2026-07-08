import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "filled" | "outline";
}

export default function PrimaryButton({ title, onPress, disabled, loading, variant = "filled" }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isOutline = variant === "outline";
  return (
    <Pressable
      style={[
        styles.button,
        isOutline ? styles.outline : styles.filled,
        disabled ? (isOutline ? styles.outlineDisabled : styles.filledDisabled) : null,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator color={isOutline ? colors.accent : "#fff"} />
      ) : (
        <Text style={isOutline ? styles.outlineText : styles.filledText}>{title}</Text>
      )}
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: { borderRadius: 12, paddingVertical: 14, alignItems: "center", width: "100%" },
    filled: { backgroundColor: colors.accent },
    filledDisabled: { backgroundColor: colors.accentSoft },
    filledText: { color: "#fff", fontSize: 16, fontWeight: "700" },
    outline: { borderWidth: 1.5, borderColor: colors.accent, backgroundColor: colors.surface },
    outlineDisabled: { borderColor: colors.border },
    outlineText: { color: colors.accent, fontSize: 16, fontWeight: "700" },
  });
