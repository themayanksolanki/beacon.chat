import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { inviteByEmail } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  loadMatchedContacts,
  lookupSingleEmail,
  normalize,
  type MatchedContact,
} from "../contacts/matchContacts";
import { getConversationByPeerKey, insertConversation } from "../db/database";
import { colorForName, colors, initialFor } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "Contacts">;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ContactsScreen({ navigation }: Props) {
  const { token, email } = useAuth();
  const [contacts, setContacts] = useState<MatchedContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  const [manualEmail, setManualEmail] = useState("");
  const [manualResult, setManualResult] = useState<MatchedContact | null>(null);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

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
        Alert.alert("Invite sent", `We emailed ${contact.email} a link to join Beacon.`);
      } catch {
        Alert.alert("Couldn't send invite", "Please try again later.");
      } finally {
        setInvitingId(null);
      }
    },
    [token]
  );

  const addByEmail = useCallback(async () => {
    if (!token) return;
    const normalized = normalize(manualEmail);
    if (!EMAIL_REGEX.test(normalized)) {
      setManualError("Enter a valid email address.");
      return;
    }
    if (email && normalized === normalize(email)) {
      setManualError("That's your own email.");
      return;
    }

    setManualError(null);
    setManualLoading(true);
    try {
      const result = await lookupSingleEmail(token, normalized);
      setManualResult(result);
      setManualEmail("");
    } catch {
      setManualError("Couldn't look that up. Please try again.");
    } finally {
      setManualLoading(false);
    }
  }, [token, email, manualEmail]);

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={contacts ?? []}
      keyExtractor={(item) => item.id}
      contentContainerStyle={contacts && contacts.length === 0 ? styles.center : undefined}
      ListHeaderComponent={
        <View style={styles.addSection}>
          <View style={styles.addRow}>
            <TextInput
              style={styles.input}
              placeholder="Add by email"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={manualEmail}
              onChangeText={(t) => {
                setManualEmail(t);
                setManualError(null);
              }}
              onSubmitEditing={addByEmail}
            />
            <Pressable style={styles.addButton} onPress={addByEmail} disabled={manualLoading}>
              {manualLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.addButtonText}>Add</Text>
              )}
            </Pressable>
          </View>
          {manualError ? <Text style={styles.manualError}>{manualError}</Text> : null}
          {manualResult ? (
            <ContactRow
              contact={manualResult}
              inviting={invitingId === manualResult.id}
              onChat={openChat}
              onInvite={invite}
            />
          ) : null}
          <Text style={styles.sectionLabel}>From your contacts</Text>
        </View>
      }
      ListEmptyComponent={
        contacts ? (
          <Text style={styles.empty}>No contacts found.</Text>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        )
      }
      renderItem={({ item }) => (
        <ContactRow
          contact={item}
          inviting={invitingId === item.id}
          onChat={openChat}
          onInvite={invite}
        />
      )}
    />
  );
}

function ContactRow({
  contact,
  inviting,
  onChat,
  onInvite,
}: {
  contact: MatchedContact;
  inviting: boolean;
  onChat: (contact: MatchedContact) => void;
  onInvite: (contact: MatchedContact) => void;
}) {
  return (
    <Pressable
      style={styles.row}
      onPress={contact.registered ? () => onChat(contact) : undefined}
      disabled={!contact.registered}
    >
      {contact.avatarUrl ? (
        <Image source={{ uri: contact.avatarUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, { backgroundColor: colorForName(contact.name) }]}>
          <Text style={styles.avatarText}>{initialFor(contact.name)}</Text>
        </View>
      )}
      <View style={styles.info}>
        <Text style={styles.name}>{contact.name}</Text>
        <Text style={styles.email}>{contact.email}</Text>
      </View>
      {contact.registered ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      ) : (
        <Pressable style={styles.inviteButton} onPress={() => onInvite(contact)} disabled={inviting}>
          {inviting ? (
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
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  empty: { color: colors.textTertiary, textAlign: "center", marginTop: 24 },
  error: { color: colors.textSecondary, textAlign: "center", paddingHorizontal: 24 },
  addSection: { paddingTop: 12, paddingHorizontal: 16, backgroundColor: colors.surface },
  addRow: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  addButton: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  manualError: { color: colors.danger, fontSize: 13, marginTop: 6 },
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    marginTop: 20,
    marginBottom: 4,
  },
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
