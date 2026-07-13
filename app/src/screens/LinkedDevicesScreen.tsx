import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { listDevices, revokeDevice, type LinkedDevice } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "LinkedDevices">;

function formatLinkedSince(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export default function LinkedDevicesScreen({}: Props) {
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const { token } = useAuth();

  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    if (!token) return;
    try {
      setDevices(await listDevices(token));
    } catch (err) {
      console.warn("[devices] failed to load linked devices", err);
    }
  }, [token]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadDevices();
    setRefreshing(false);
  }, [loadDevices]);

  const confirmRemove = useCallback(
    (device: LinkedDevice) => {
      if (!token) return;
      Alert.alert(
        device.isCurrentDevice ? "Log out this device?" : `Remove "${device.name ?? "this device"}"?`,
        device.isCurrentDevice
          ? "This is the device you're using right now — removing it will log you out here."
          : "This device will be signed out immediately and will need to log in again to reconnect.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: device.isCurrentDevice ? "Log out" : "Remove",
            style: "destructive",
            onPress: async () => {
              setRevokingId(device.id);
              try {
                await revokeDevice(token, device.id);
                // If this was the current device, the server's session:revoked
                // socket event (already handled in AuthContext) signs the app
                // out from here shortly — no need to navigate away manually.
                setDevices((prev) => prev?.filter((d) => d.id !== device.id) ?? prev);
              } catch {
                Alert.alert("Couldn't remove device", "Please check your connection and try again.");
              } finally {
                setRevokingId(null);
              }
            },
          },
        ]
      );
    },
    [token]
  );

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.textTertiary} />}
    >
      <Text style={styles.sectionHeader}>LINKED DEVICES</Text>
      <View style={styles.section}>
        {devices === null ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.textTertiary} />
          </View>
        ) : devices.length === 0 ? (
          <View style={styles.loadingRow}>
            <Text style={styles.emptyText}>No linked devices found.</Text>
          </View>
        ) : (
          devices.map((device, index) => (
            <View key={device.id}>
              {index > 0 && <View style={styles.divider} />}
              <View style={styles.row}>
                <View style={styles.rowLeft}>
                  <Ionicons
                    name={device.isCurrentDevice ? "phone-portrait" : "phone-portrait-outline"}
                    size={20}
                    color={colors.text}
                  />
                  <View>
                    <View style={styles.nameRow}>
                      <Text style={styles.rowLabel}>{device.name ?? "Unnamed device"}</Text>
                      {device.isCurrentDevice && (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>This device</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.rowSubtitle}>
                      {device.lastSeenAt
                        ? `Last active ${formatLinkedSince(device.lastSeenAt)}`
                        : `Linked ${formatLinkedSince(device.createdAt)}`}
                    </Text>
                  </View>
                </View>
                {revokingId === device.id ? (
                  <ActivityIndicator size="small" color={colors.textTertiary} />
                ) : (
                  <Pressable onPress={() => confirmRemove(device)} hitSlop={8}>
                    <Ionicons name="close-circle-outline" size={22} color={colors.danger} />
                  </Pressable>
                )}
              </View>
            </View>
          ))
        )}
      </View>
      <Text style={styles.sectionFooter}>
        Removing a device signs it out immediately. It will need to log in again to reconnect.
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
      gap: 10,
      flex: 1,
    },
    nameRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginLeft: 46,
    },
    rowLabel: { fontSize: 16, color: colors.text },
    rowSubtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
    loadingRow: { paddingVertical: 24, alignItems: "center", justifyContent: "center" },
    emptyText: { fontSize: 14, color: colors.textSecondary },
    badge: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    badgeText: { fontSize: 11, fontWeight: "600", color: "#fff" },
  });
