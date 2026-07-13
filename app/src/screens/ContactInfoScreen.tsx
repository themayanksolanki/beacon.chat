import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";

import type { MainStackParamList } from "../../App";
import { getUserById } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { useCall } from "../calls/CallContext";
import { clearConversation } from "../chat/clearConversation";
import { deleteConversation } from "../chat/deleteConversation";
import { extractLinks } from "../chat/linkify";
import {
  blockUser,
  getConversationById,
  getFileMessages,
  getMediaMessages,
  getTextMessages,
  isUserBlocked,
  unblockUser,
  updateConversationProfile,
} from "../db/database";
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

// Same chunk count/shape as formatFingerprint's output, so hiding it doesn't
// change the row's layout width when it's later revealed.
function maskFingerprint(key: string): string {
  return (
    key
      .replace(/[^a-zA-Z0-9]/g, "")
      .match(/.{1,4}/g)
      ?.map(() => "••••")
      .join(" ") ?? "••••"
  );
}

function formatMemberSince(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

/** Total link occurrences across every text message in the conversation — same regex the Links tab/inline chat linkification use, see chat/linkify.ts. */
function countLinks(conversationId: string): number {
  return getTextMessages(conversationId).reduce((sum, message) => sum + extractLinks(message.plaintext).length, 0);
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
  const [mediaCount, setMediaCount] = useState(() => getMediaMessages(conversationId).length);
  const [docsCount, setDocsCount] = useState(() => getFileMessages(conversationId).length);
  const [linksCount, setLinksCount] = useState(() => countLinks(conversationId));
  const [showFingerprint, setShowFingerprint] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setMediaCount(getMediaMessages(conversationId).length);
      setDocsCount(getFileMessages(conversationId).length);
      setLinksCount(countLinks(conversationId));
    }, [conversationId])
  );
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
  // WhatsApp-style single combined count for the "Media, links and docs"
  // row below — the breakdown by kind only shows up once you tap through to
  // SharedMediaScreen's tabs.
  const sharedContentCount = mediaCount + docsCount + linksCount;

  const copyFingerprint = async () => {
    await Clipboard.setStringAsync(conversation.peer_public_key);
    Alert.alert("Copied", "Encryption key copied to clipboard.");
  };

  const confirmComingSoonPay = () => {
    Alert.alert("Coming soon", "UPI payments are coming soon.");
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
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Plain, not a card like the grouped sections below — this is the
          identity header, not a "group of settings," so it sits directly on
          the screen background instead of floating in its own surface. */}
      <View style={styles.profileSection}>
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
          <Pressable
            style={styles.actionButton}
            onPress={() => navigation.navigate("Chat", { conversationId, openSearch: true })}
          >
            <Ionicons name="search" size={20} color={colors.accent} />
            <Text style={styles.actionLabel}>Search</Text>
          </Pressable>
          <Pressable style={styles.actionButton} onPress={confirmComingSoonPay}>
            <MaterialCommunityIcons name="currency-inr" size={20} color={colors.accent} />
            <Text style={styles.actionLabel}>Pay</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Pressable style={styles.row} onPress={() => navigation.navigate("SharedMedia", { conversationId })}>
          <View style={styles.mediaRowLeft}>
            <Ionicons name="image-outline" size={20} color={colors.text} />
            <Text style={styles.rowLabel}>Media, links and docs</Text>
          </View>
          <View style={styles.mediaRowLeft}>
            <Text style={styles.rowValue}>{sharedContentCount}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          </View>
        </Pressable>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Ionicons name="lock-closed" size={11} color={colors.textSecondary} />
          <Text style={styles.sectionTitle}>Encryption</Text>
        </View>
        <Pressable style={styles.row} onPress={() => setShowFingerprint((prev) => !prev)}>
          <View style={styles.info}>
            <Text style={styles.rowLabel}>Verification key</Text>
            <Text style={styles.fingerprint} numberOfLines={2}>
              {showFingerprint
                ? formatFingerprint(conversation.peer_public_key)
                : maskFingerprint(conversation.peer_public_key)}
            </Text>
          </View>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              void copyFingerprint();
            }}
            hitSlop={8}
          >
            <Ionicons name="copy-outline" size={18} color={colors.textTertiary} />
          </Pressable>
        </Pressable>
      </View>

      {conversation.contact_number ? (
        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Contact number</Text>
            <Text style={styles.rowValue}>{conversation.contact_number}</Text>
          </View>
        </View>
      ) : null}

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

      <View style={styles.section}>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>In Beacon since</Text>
          <Text style={styles.rowValue}>{formatMemberSince(peerCreatedAt ?? conversation.created_at)}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scrollContent: { paddingTop: 20, paddingBottom: 32 },
    // Grouped rows below (encryption, contact details, media, chat/account
    // actions) each get their own floating card — inset from the screen
    // edges with rounded corners, instead of the old edge-to-edge banded
    // sections — while the profile header above stays plain (see
    // profileSection).
    section: {
      backgroundColor: colors.surface,
      marginHorizontal: 16,
      marginBottom: 20,
      borderRadius: 16,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 3,
      elevation: 1,
    },
    // Deliberately not a card like `section` above — this is the identity
    // header (who this is), not a group of settings rows, so it sits
    // directly on the screen background.
    profileSection: { marginBottom: 20 },
    profile: { alignItems: "center", paddingVertical: 24, paddingHorizontal: 0, },
    avatar: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center" },
    avatarInitial: { fontSize: 32, fontWeight: "700", color: "#fff" },
    name: { fontSize: 20, fontWeight: "600", color: colors.text, marginTop: 6 },
    // Brighter than the usual textSecondary dim gray — now that this sits
    // directly on the plain screen background instead of a card surface, the
    // old secondary tone read too faint next to the name above it.
    status: { fontSize: 13, color: colors.text },
    actionsRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 16,
      paddingBottom: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 16,
    },
    // Same rounded-corner radius and shadow as the grouped cards below
    // (`section`) — Audio/Video/Search read as small versions of the same
    // card language rather than bare icon+label pairs floating on the
    // screen background.
    actionButton: {
      alignItems: "center",
      gap: 6,
      minWidth: 76,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 16,
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 3,
      elevation: 1,
    },
    actionLabel: { fontSize: 12, color: colors.accent, fontWeight: "500" },
    sectionTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textSecondary,
      textTransform: "uppercase",
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
    mediaRowLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
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
