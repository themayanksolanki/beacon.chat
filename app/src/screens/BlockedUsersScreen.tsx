import { useCallback, useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { MainStackParamList } from "../../App";
import { getUserById } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { listBlockedUsers, unblockUser, type BlockedUserRow } from "../db/database";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "BlockedUsers">;

interface DisplayRow extends BlockedUserRow {
  resolvedName: string | null;
  resolvedAvatarUrl: string | null;
}

export default function BlockedUsersScreen({}: Props) {
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const { token } = useAuth();

  const [rows, setRows] = useState<DisplayRow[]>([]);

  const load = useCallback(() => {
    const blocked = listBlockedUsers();
    setRows(blocked.map((b) => ({ ...b, resolvedName: b.display_name, resolvedAvatarUrl: b.avatar_url })));

    // Best-effort enrichment for entries with no cached profile — blocking
    // straight from an incoming contact request deletes the conversation
    // row (see contactRequests.ts), so there's nothing local to show yet.
    // Display-only: never written back to the local DB.
    if (!token) return;
    for (const b of blocked) {
      if (b.display_name) continue;
      getUserById(token, b.peer_id)
        .then((peer) => {
          setRows((prev) =>
            prev.map((r) =>
              r.peer_id === b.peer_id ? { ...r, resolvedName: peer.name, resolvedAvatarUrl: peer.avatarUrl } : r
            )
          );
        })
        .catch(() => {
          // Leave the fallback showing — the account may no longer exist.
        });
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const confirmUnblock = useCallback((row: DisplayRow) => {
    const label = row.resolvedName ?? "this user";
    Alert.alert("Unblock user", `Unblock ${label}? They'll be able to message and call you again.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unblock",
        onPress: () => {
          unblockUser(row.peer_id);
          setRows((prev) => prev.filter((r) => r.peer_id !== row.peer_id));
        },
      },
    ]);
  }, []);

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.sectionHeader}>BLOCKED USERS</Text>
      <View style={styles.section}>
        {rows.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>No blocked users.</Text>
          </View>
        ) : (
          rows.map((row, index) => (
            <View key={row.peer_id}>
              {index > 0 && <View style={styles.divider} />}
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  {row.resolvedAvatarUrl ? (
                    <Image source={{ uri: row.resolvedAvatarUrl }} style={styles.avatar} />
                  ) : (
                    <View style={[styles.avatar, { backgroundColor: colorForName(row.resolvedName ?? "?") }]}>
                      <Text style={styles.avatarInitial}>{initialFor(row.resolvedName)}</Text>
                    </View>
                  )}
                  <Text style={styles.rowLabel}>{row.resolvedName ?? "Unknown"}</Text>
                </View>
                <Pressable onPress={() => confirmUnblock(row)} hitSlop={8}>
                  <Text style={styles.unblockLabel}>Unblock</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </View>
      <Text style={styles.sectionFooter}>
        Blocked users can't message or call you, and won't see when you're online.
      </Text>
    </ScrollView>
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
      gap: 12,
    },
    rowLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flex: 1,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginLeft: 60,
    },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
    avatarInitial: { fontSize: 15, fontWeight: "700", color: "#fff" },
    rowLabel: { fontSize: 16, color: colors.text },
    unblockLabel: { fontSize: 15, fontWeight: "600", color: colors.accent },
    emptyRow: { paddingVertical: 24, alignItems: "center", justifyContent: "center" },
    emptyText: { fontSize: 14, color: colors.textSecondary },
  });
