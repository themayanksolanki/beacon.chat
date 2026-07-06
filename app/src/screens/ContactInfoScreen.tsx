import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";

import type { MainStackParamList } from "../../App";
import { useCall } from "../calls/CallContext";
import { clearConversation } from "../chat/clearConversation";
import { getConversationById } from "../db/database";
import { usePresence } from "../presence/PresenceContext";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "ContactInfo">;

// Groups the base64 public key into short chunks so it reads like a
// verification code instead of an unbroken wall of characters.
function formatFingerprint(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").match(/.{1,4}/g)?.join(" ") ?? key;
}

function formatMemberSince(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export default function ContactInfoScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const conversation = getConversationById(conversationId);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { startCall } = useCall();
  const { presence } = usePresence();
  const peerPresence = presence[conversationId];

  if (!conversation) {
    return <View style={styles.container} />;
  }

  const name = conversation.display_name ?? "Unknown";

  const copyFingerprint = async () => {
    await Clipboard.setStringAsync(conversation.peer_public_key);
    Alert.alert("Copied", "Encryption key copied to clipboard.");
  };

  const confirmClearChat = () => {
    Alert.alert("Clear chat", `Delete all messages with ${name}? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          clearConversation(conversationId);
          navigation.goBack();
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <View style={styles.profile}>
          <View style={[styles.avatar, { backgroundColor: colorForName(name) }]}>
            <Text style={styles.avatarInitial}>{initialFor(name)}</Text>
          </View>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.status}>{peerPresence?.online ? "Active now" : "Offline"}</Text>
        </View>

        <View style={styles.actionsRow}>
          <Pressable style={styles.actionButton} onPress={() => startCall(conversationId, "audio")}>
            <Ionicons name="call" size={20} color={colors.accent} />
            <Text style={styles.actionLabel}>Audio</Text>
          </Pressable>
          <Pressable style={styles.actionButton} onPress={() => startCall(conversationId, "video")}>
            <Ionicons name="videocam" size={20} color={colors.accent} />
            <Text style={styles.actionLabel}>Video</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Encryption</Text>
        <Pressable style={styles.row} onPress={copyFingerprint}>
          <View style={styles.info}>
            <Text style={styles.rowLabel}>Verification key</Text>
            <Text style={styles.fingerprint} numberOfLines={2}>
              {formatFingerprint(conversation.peer_public_key)}
            </Text>
          </View>
          <Ionicons name="copy-outline" size={18} color={colors.textTertiary} />
        </Pressable>
      </View>

      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>In Beacon since</Text>
          <Text style={styles.rowValue}>{formatMemberSince(conversation.created_at)}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Pressable style={styles.dangerRow} onPress={confirmClearChat}>
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
          <Text style={styles.dangerLabel}>Clear chat</Text>
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
    profile: { alignItems: "center", paddingVertical: 24, gap: 6 },
    avatar: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center" },
    avatarInitial: { fontSize: 32, fontWeight: "700", color: "#fff" },
    name: { fontSize: 20, fontWeight: "600", color: colors.text, marginTop: 6 },
    status: { fontSize: 13, color: colors.textSecondary },
    actionsRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 32,
      paddingBottom: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 16,
    },
    actionButton: { alignItems: "center", gap: 6 },
    actionLabel: { fontSize: 12, color: colors.accent, fontWeight: "500" },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
      textTransform: "uppercase",
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 10,
    },
    info: { flex: 1 },
    rowLabel: { fontSize: 16, color: colors.text },
    rowValue: { fontSize: 15, color: colors.textSecondary },
    fingerprint: { fontSize: 13, color: colors.textSecondary, marginTop: 4, fontFamily: "Menlo" },
    dangerRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 10,
    },
    dangerLabel: { fontSize: 16, color: colors.danger, fontWeight: "500" },
  });
