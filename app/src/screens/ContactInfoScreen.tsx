import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";

import type { MainStackParamList } from "../../App";
import { getUserById } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useCall } from "../calls/CallContext";
import { clearConversation } from "../chat/clearConversation";
import { deleteConversation } from "../chat/deleteConversation";
import { blockUser, getConversationById, isUserBlocked, unblockUser, updateConversationProfile } from "../db/database";
import { usePresence } from "../presence/PresenceContext";
import { TEST_BOT_CONVERSATION_ID } from "../testBot";
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
  const { token } = useAuth();
  const [conversation, setConversation] = useState(() => getConversationById(conversationId));
  // Peer's actual account-creation date from the server, distinct from
  // conversation.created_at (which is when *this device* first talked to
  // them) — kept separate rather than overwriting that column's meaning.
  const [peerCreatedAt, setPeerCreatedAt] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(() => isUserBlocked(conversationId));
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { startCall } = useCall();
  const { presence } = usePresence();
  const peerPresence = presence[conversationId];

  // Local SQLite only ever has whatever the peer's profile looked like at
  // first contact (or the last time some other screen refreshed it) — fetch
  // the latest name/avatar/contact number/join date from the server so this
  // profile view doesn't show stale data. A failed fetch (offline, server
  // down) just leaves the cached copy on screen.
  useEffect(() => {
    if (conversationId === TEST_BOT_CONVERSATION_ID || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const peer = await getUserById(token, conversationId);
        if (cancelled) return;
        updateConversationProfile(conversationId, peer.name, peer.avatarUrl, peer.contactNumber);
        setConversation(getConversationById(conversationId));
        setPeerCreatedAt(peer.createdAt);
      } catch (err) {
        console.warn("[contact-info] failed to refresh peer profile", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, token]);

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

  // Deleting/removing here leaves nothing behind to come back to — pop past
  // both this screen and the chat screen at once, straight to the list,
  // rather than a single goBack() that would strand the user on a chat
  // screen for a conversation that no longer exists.
  const confirmDeleteChat = () => {
    Alert.alert("Delete chat", `Delete your conversation with ${name}? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteConversation(conversationId);
          navigation.pop(2);
        },
      },
    ]);
  };

  const confirmBlockUser = () => {
    Alert.alert("Block user", `Block ${name}? They won't be able to message or call you.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Block",
        style: "destructive",
        onPress: () => {
          blockUser(conversationId);
          setBlocked(true);
        },
      },
    ]);
  };

  const confirmUnblockUser = () => {
    Alert.alert("Unblock user", `Unblock ${name}? You'll be able to message and call them again.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unblock",
        onPress: () => {
          unblockUser(conversationId);
          setBlocked(false);
        },
      },
    ]);
  };

  const confirmRemoveUser = () => {
    Alert.alert("Remove user", `Remove ${name} and delete this conversation? This can't be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          blockUser(conversationId);
          deleteConversation(conversationId);
          navigation.pop(2);
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <View style={styles.profile}>
          {conversation.avatar_url ? (
            <Image source={{ uri: conversation.avatar_url }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, { backgroundColor: colorForName(name) }]}>
              <Text style={styles.avatarInitial}>{initialFor(name)}</Text>
            </View>
          )}
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.status}>{!blocked && peerPresence?.online ? "Active now" : "Offline"}</Text>
        </View>

        <View style={styles.actionsRow}>
          <Pressable
            style={styles.actionButton}
            onPress={() => startCall(conversationId, "audio")}
            disabled={blocked}
          >
            <Ionicons name="call" size={20} color={blocked ? colors.textTertiary : colors.accent} />
            <Text style={[styles.actionLabel, blocked && { color: colors.textTertiary }]}>Audio</Text>
          </Pressable>
          <Pressable
            style={styles.actionButton}
            onPress={() => startCall(conversationId, "video")}
            disabled={blocked}
          >
            <Ionicons name="videocam" size={20} color={blocked ? colors.textTertiary : colors.accent} />
            <Text style={[styles.actionLabel, blocked && { color: colors.textTertiary }]}>Video</Text>
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
        {conversation.contact_number ? (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Contact number</Text>
            <Text style={styles.rowValue}>{conversation.contact_number}</Text>
          </View>
        ) : null}
        <View style={styles.row}>
          <Text style={styles.rowLabel}>In Beacon since</Text>
          <Text style={styles.rowValue}>{formatMemberSince(peerCreatedAt ?? conversation.created_at)}</Text>
        </View>
      </View>

      {/* Clear Chat gets its own container, separate from the account-level
          actions below — it's a lighter-weight, non-destructive-to-the-
          relationship action (just wipes local history) so it isn't styled
          red like the others. */}
      <View style={styles.section}>
        <Pressable style={styles.optionRow} onPress={confirmClearChat}>
          <MaterialCommunityIcons name="broom" size={20} color={colors.text} />
          <Text style={[styles.optionLabel, { color: colors.text }]}>Clear Chat</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Pressable style={[styles.optionRow, styles.optionRowDivider]} onPress={confirmDeleteChat}>
          <Ionicons name="trash-outline" size={20} color={colors.text} />
          <Text style={[styles.optionLabel, { color: colors.text }]}>Delete Chat</Text>
        </Pressable>
        {blocked ? (
          <Pressable style={[styles.optionRow, styles.optionRowDivider]} onPress={confirmUnblockUser}>
            <Ionicons name="checkmark-circle-outline" size={20} color={colors.text} />
            <Text style={[styles.optionLabel, { color: colors.text }]}>Unblock User</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.optionRow, styles.optionRowDivider]} onPress={confirmBlockUser}>
            <Ionicons name="ban-outline" size={20} color={colors.danger} />
            <Text style={[styles.optionLabel, { color: colors.danger }]}>Block User</Text>
          </Pressable>
        )}
        <Pressable style={styles.optionRow} onPress={confirmRemoveUser}>
          <Ionicons name="person-remove-outline" size={20} color={colors.text} />
          <Text style={[styles.optionLabel, { color: colors.text }]}>Remove User</Text>
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
    profile: { alignItems: "center", paddingVertical: 24, paddingHorizontal: 0, },
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
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 10,
    },
    optionRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    optionLabel: { fontSize: 16, fontWeight: "500" },
  });
