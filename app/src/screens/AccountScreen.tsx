import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

export default function AccountScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { email, logout, deleteAccount } = useAuth();
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

  const openUpdateEmail = useCallback(() => {
    Alert.alert("Coming soon", "Updating your email address isn't supported yet.");
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.sectionHeader}>EMAIL</Text>
      <View style={styles.section}>
        <View style={styles.row}>
          <View style={styles.rowLeft}>
            <Ionicons name="mail-outline" size={20} color={colors.text} />
            <Text style={styles.emailLabel}>{email}</Text>
          </View>
        </View>
        <View style={styles.divider} />
        <Pressable style={styles.row} onPress={openUpdateEmail}>
          <View style={styles.rowLeft}>
            <Ionicons name="pencil-outline" size={20} color={colors.text} />
            <Text style={styles.rowLabel}>Update email</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
        </Pressable>
      </View>
      <Text style={styles.sectionFooter}>This is the email address associated with your account.</Text>

      <Text style={styles.sectionHeader}>SESSION</Text>
      <View style={styles.section}>
        <Pressable style={styles.row} onPress={() => logout()} disabled={deleting}>
          <View style={styles.rowLeft}>
            <Ionicons name="log-out-outline" size={20} color={colors.text} />
            <Text style={styles.rowLabel}>Log out</Text>
          </View>
        </Pressable>
      </View>
      <Text style={styles.sectionFooter}>You can log back in anytime using this email.</Text>

      <Text style={styles.sectionHeader}>DANGER ZONE</Text>
      <View style={styles.section}>
        <Pressable style={styles.row} onPress={confirmDeleteAccount} disabled={deleting}>
          <View style={styles.rowLeft}>
            <Ionicons name="trash-outline" size={20} color={colors.danger} />
            <Text style={styles.destructiveLabel}>Delete account</Text>
          </View>
          {deleting && <ActivityIndicator size="small" color={colors.textTertiary} />}
        </Pressable>
      </View>
      <Text style={styles.sectionFooter}>
        Your account and all messages will be permanently deleted 48 hours after you request deletion. Log
        back in before then to cancel.
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, paddingTop: 20 },
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
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    rowLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginLeft: 46,
    },
    rowLabel: { fontSize: 16, color: colors.text },
    destructiveLabel: { fontSize: 16, color: colors.danger },
    emailLabel: { fontSize: 15, color: colors.textSecondary },
  });
