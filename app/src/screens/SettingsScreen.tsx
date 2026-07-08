import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";
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
  const { profile, email, logout, deleteAccount } = useAuth();
  const [deleting, setDeleting] = useState(false);

  const confirmDeleteAccount = useCallback(() => {
    Alert.alert(
      "Delete account",
      "Your account and all messages will be permanently deleted in 48 hours. Log back in before then to cancel — after that, this can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteAccount();
            } catch {
              setDeleting(false);
              Alert.alert("Couldn't delete account", "Please check your connection and try again.");
            }
          },
        },
      ]
    );
  }, [deleteAccount]);

  const openAccountMenu = useCallback(() => {
    Alert.alert("Account", email ?? undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", onPress: () => logout() },
      { text: "Delete account", style: "destructive", onPress: confirmDeleteAccount },
    ]);
  }, [email, logout, confirmDeleteAccount]);

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
        <Pressable style={styles.accountRow} onPress={openAccountMenu} disabled={deleting}>
          <View style={styles.accountRowLeft}>
            <Ionicons name="person-circle-outline" size={20} color={colors.text} />
            <Text style={styles.rowLabel}>Account</Text>
          </View>
          {deleting ? (
            <ActivityIndicator size="small" color={colors.textTertiary} />
          ) : (
            <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
          )}
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
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    accountRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    accountRowLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
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
  });
