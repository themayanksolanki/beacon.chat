import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { inviteByEmail } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { loadMatchedContacts, type MatchedContact } from "../contacts/matchContacts";
import { getConversationByPeerKey, insertConversation } from "../db/database";
import { colorForName, colors, initialFor } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "Contacts">;

export default function ContactsScreen({ navigation }: Props) {
  const { token, email } = useAuth();
  const [contacts, setContacts] = useState<MatchedContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !email) return;
    loadMatchedContacts(token, email)
      .then(setContacts)
      .catch((e) =>
        setError(
          e instanceof Error && e.message === "contacts_permission_denied"
            ? "Beacon needs contacts access to show you who's already here. You can enable it in Settings."
            : "Couldn't load contacts."
        )
      );
  }, [token, email]);

  const openChat = useCallback(
    (contact: MatchedContact) => {
      if (!contact.publicKey) return;
      let conversation = getConversationByPeerKey(contact.publicKey);
      if (!conversation) {
        conversation = {
          id: contact.userId!,
          peer_public_key: contact.publicKey,
          display_name: contact.name,
          created_at: Date.now(),
        };
        insertConversation(conversation);
      }
      navigation.navigate("Chat", { conversationId: conversation.id });
    },
    [navigation]
  );

  const invite = useCallback(
    async (contact: MatchedContact) => {
      if (!token) return;
      setInvitingId(contact.id);
      try {
        await inviteByEmail(token, contact.email);
        Alert.alert("Invite sent", `We emailed ${contact.name} a link to join Beacon.`);
      } catch {
        Alert.alert("Couldn't send invite", "Please try again later.");
      } finally {
        setInvitingId(null);
      }
    },
    [token]
  );

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!contacts) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FlatList
      data={contacts}
      keyExtractor={(item) => item.id}
      contentContainerStyle={contacts.length === 0 ? styles.center : undefined}
      ListEmptyComponent={<Text style={styles.empty}>No contacts found.</Text>}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={item.registered ? () => openChat(item) : undefined}
          disabled={!item.registered}
        >
          <View style={[styles.avatar, { backgroundColor: colorForName(item.name) }]}>
            <Text style={styles.avatarText}>{initialFor(item.name)}</Text>
          </View>
          <View style={styles.info}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.email}>{item.email}</Text>
          </View>
          {item.registered ? (
            <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
          ) : (
            <Pressable
              style={styles.inviteButton}
              onPress={() => invite(item)}
              disabled={invitingId === item.id}
            >
              {invitingId === item.id ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <>
                  <Ionicons name="mail-outline" size={14} color={colors.accent} />
                  <Text style={styles.inviteText}>Invite</Text>
                </>
              )}
            </Pressable>
          )}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  empty: { color: colors.textTertiary },
  error: { color: colors.textSecondary, textAlign: "center", paddingHorizontal: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 16, fontWeight: "700", color: "#fff" },
  info: { flex: 1 },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  email: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  inviteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 68,
    justifyContent: "center",
  },
  inviteText: { color: colors.accent, fontWeight: "600", fontSize: 13 },
});
