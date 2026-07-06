import { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../ThemeContext";
import type { ThemePreference } from "../storage/themeStore";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "Settings">;

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen({ navigation }: Props) {
  const { colors, preference, setPreference } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { profile, email, logout } = useAuth();

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Pressable style={styles.profileRow} onPress={() => navigation.navigate("EditProfile")}>
          {profile?.photoUri ? (
            <Image source={{ uri: profile.photoUri }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: colorForName(profile?.fullName ?? "?") }]}>
              <Text style={styles.avatarInitial}>{initialFor(profile?.fullName)}</Text>
            </View>
          )}
          <View style={styles.info}>
            <Text style={styles.name}>{profile?.fullName}</Text>
            <Text style={styles.email}>{email}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appearance</Text>
        {APPEARANCE_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            style={styles.optionRow}
            onPress={() => setPreference(option.value)}
          >
            <Text style={styles.rowLabel}>{option.label}</Text>
            {preference === option.value && (
              <Ionicons name="checkmark" size={20} color={colors.accent} />
            )}
          </Pressable>
        ))}
      </View>

      <View style={styles.section}>
        <Pressable style={styles.row} onPress={() => logout()}>
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.logout}>Log out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, paddingTop: 20 },
    section: {
      backgroundColor: colors.surface,
      marginBottom: 24,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    profileRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 12,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 10,
    },
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    rowLabel: { fontSize: 16, color: colors.text },
    avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
    avatarInitial: { fontSize: 20, fontWeight: "700", color: "#fff" },
    info: { flex: 1 },
    name: { fontSize: 16, fontWeight: "600", color: colors.text },
    email: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    logout: { fontSize: 16, color: colors.danger, fontWeight: "500" },
  });
