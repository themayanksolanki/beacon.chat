import { useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList, MainTabParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Settings">,
  NativeStackScreenProps<MainStackParamList>
>;

const APPEARANCE_LABELS = { system: "System", light: "Light", dark: "Dark" };

function matches(keywords: string[], query: string): boolean {
  if (!query) return true;
  return keywords.some((keyword) => keyword.toLowerCase().includes(query));
}

export default function SettingsScreen({ navigation }: Props) {
  const { colors, preference } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { profile, email } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const query = searchQuery.trim().toLowerCase();

  const showProfile = matches(["profile", "edit profile", "name", "photo", "phone number", profile?.fullName ?? "", email ?? ""], query);
  const showAppearance = matches(["appearance", "theme", "dark mode", "light mode", "system"], query);
  const showAccount = matches(["account", "sign in", "sign out", "delete account"], query);
  const showBlockedUsers = matches(["privacy", "blocked users", "block"], query);
  const noResults = query.length > 0 && !showProfile && !showAppearance && !showAccount && !showBlockedUsers;

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search settings"
          placeholderTextColor={colors.textTertiary}
          style={styles.searchInput}
        />
        {searchQuery ? (
          <Pressable onPress={() => setSearchQuery("")} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
          </Pressable>
        ) : null}
      </View>

      {noResults ? (
        <View style={styles.center}>
          <Ionicons name="search-outline" size={32} color={colors.textTertiary} />
          <Text style={styles.empty}>No settings match your search</Text>
        </View>
      ) : (
        <>
          {showProfile ? (
            <>
              <Text style={styles.sectionHeader}>PROFILE</Text>
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
              <Text style={styles.sectionFooter}>Tap to edit your name, photo, and phone number.</Text>
            </>
          ) : null}

          {showAppearance ? (
            <>
              <Text style={styles.sectionHeader}>APPEARANCE</Text>
              <View style={styles.section}>
                <Pressable style={styles.accountRow} onPress={() => navigation.navigate("Appearance")}>
                  <View style={styles.accountRowLeft}>
                    <Ionicons name="color-palette-outline" size={20} color={colors.text} />
                    <Text style={styles.rowLabel}>Appearance</Text>
                  </View>
                  <View style={styles.accountRowLeft}>
                    <Text style={styles.rowValue}>{APPEARANCE_LABELS[preference]}</Text>
                    <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                  </View>
                </Pressable>
              </View>
              <Text style={styles.sectionFooter}>Choose how Beacon Chat looks on this device.</Text>
            </>
          ) : null}

          {showAccount ? (
            <>
              <Text style={styles.sectionHeader}>ACCOUNT</Text>
              <View style={styles.section}>
                <Pressable style={styles.accountRow} onPress={() => navigation.navigate("Account")}>
                  <View style={styles.accountRowLeft}>
                    <Ionicons name="person-circle-outline" size={20} color={colors.text} />
                    <Text style={styles.rowLabel}>Account</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                </Pressable>
              </View>
              <Text style={styles.sectionFooter}>Manage sign-in and account deletion.</Text>
            </>
          ) : null}

          {showBlockedUsers ? (
            <>
              <Text style={styles.sectionHeader}>PRIVACY</Text>
              <View style={styles.section}>
                <Pressable style={styles.accountRow} onPress={() => navigation.navigate("BlockedUsers")}>
                  <View style={styles.accountRowLeft}>
                    <Ionicons name="hand-left-outline" size={20} color={colors.text} />
                    <Text style={styles.rowLabel}>Blocked Users</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
                </Pressable>
              </View>
              <Text style={styles.sectionFooter}>Blocked users can't message or call you.</Text>
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, paddingTop: 12 },
    center: { alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 60 },
    empty: { color: colors.textTertiary },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 16,
      marginBottom: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
    section: {
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
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
      paddingBottom: 24,
    },
    profileRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 12,
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
    rowLabel: { fontSize: 16, color: colors.text },
    rowValue: { fontSize: 16, color: colors.textSecondary },
    avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
    avatarInitial: { fontSize: 20, fontWeight: "700", color: "#fff" },
    info: { flex: 1 },
    name: { fontSize: 16, fontWeight: "600", color: colors.text },
    email: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  });
