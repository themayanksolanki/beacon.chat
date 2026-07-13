import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "../ThemeContext";
import type { ThemePreference } from "../storage/themeStore";
import type { ThemeColors } from "../theme";

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: "system", label: "System", icon: "phone-portrait-outline" },
  { value: "light", label: "Light", icon: "sunny-outline" },
  { value: "dark", label: "Dark", icon: "moon-outline" },
];

export default function AppearanceScreen() {
  const { colors, preference, setPreference } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <Text style={styles.sectionHeader}>THEME</Text>
      <View style={styles.section}>
        {APPEARANCE_OPTIONS.map((option) => (
          <Pressable key={option.value} style={styles.optionRow} onPress={() => setPreference(option.value)}>
            <View style={styles.optionLeft}>
              <Ionicons name={option.icon} size={20} color={colors.text} />
              <Text style={styles.rowLabel}>{option.label}</Text>
            </View>
            {preference === option.value && <Ionicons name="checkmark" size={20} color={colors.accent} />}
          </Pressable>
        ))}
      </View>
      <Text style={styles.sectionFooter}>
        Choose how Beacon Chat looks on this device. System matches your device's display settings
        automatically.
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, paddingTop: 20 },
    // Same floating-card treatment as ContactInfoScreen/SettingsScreen's
    // grouped sections — inset with rounded corners and a subtle shadow,
    // instead of the old edge-to-edge banded look.
    section: {
      backgroundColor: colors.surface,
      marginHorizontal: 16,
      borderRadius: 16,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 3,
      elevation: 1,
    },
    sectionHeader: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingBottom: 6,
    },
    sectionFooter: {
      fontSize: 13,
      color: colors.textSecondary,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    optionLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    rowLabel: { fontSize: 16, color: colors.text },
  });
