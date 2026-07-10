import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { ApiError, inviteByEmail } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import {
  loadMatchedContacts,
  lookupSingleEmail,
  lookupSinglePhone,
  normalize,
  type MatchedContact,
} from "../contacts/matchContacts";
import PhoneNumberInput from "../components/PhoneNumberInput";
import { DEFAULT_COUNTRY, type CountryDialCode } from "../constants/countryCodes";
import { getConversationByPeerKey, insertConversation, isUserBlocked, setConversationStatus } from "../db/database";
import { getSocket } from "../network/socket";
import { isValidLocalNumber, toE164 } from "../phone/phoneValidation";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "Contacts">;

type AddMode = "email" | "phone";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ContactsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { token, email } = useAuth();
  const [contacts, setContacts] = useState<MatchedContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitingId, setInvitingId] = useState<string | null>(null);

  const [addMode, setAddMode] = useState<AddMode>("email");
  const [manualEmail, setManualEmail] = useState("");
  const [manualCountry, setManualCountry] = useState<CountryDialCode>(DEFAULT_COUNTRY);
  const [manualPhoneDigits, setManualPhoneDigits] = useState("");
  const [manualPhoneTouched, setManualPhoneTouched] = useState(false);
  const [manualResult, setManualResult] = useState<MatchedContact | null>(null);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const switchMode = useCallback((mode: AddMode) => {
    setAddMode(mode);
    setManualError(null);
    setManualResult(null);
    setManualEmail("");
    setManualPhoneDigits("");
    setManualPhoneTouched(false);
  }, []);

  useEffect(() => {
    if (!token || !email) return;
    loadMatchedContacts(token, email)
      .then((list) => setContacts(list.filter((c) => !c.userId || !isUserBlocked(c.userId))))
      .catch((e) =>
        setError(
          e instanceof Error && e.message === "contacts_permission_denied"
            ? "Beacon needs contacts access to show you who's already here. You can enable it in Settings."
            : "Couldn't load contacts."
        )
      );
  }, [token, email]);

  // Starting a chat with someone new no longer opens it directly — it sends
  // a contact request and the other side has to accept before messaging (or
  // calling) is enabled on either end. An existing conversation (already
  // pending or accepted) is just opened as before; only a brand new contact,
  // or one who previously declined, goes through contact:request again.
  const startConversation = useCallback(
    (contact: MatchedContact) => {
      if (!contact.publicKey || !contact.userId || !token) return;
      if (isUserBlocked(contact.userId)) return;
      const peerId = contact.userId;
      const peerPublicKey = contact.publicKey;

      const existing = getConversationByPeerKey(peerPublicKey);
      if (existing && existing.status !== "declined") {
        navigation.navigate("Chat", { conversationId: existing.id });
        return;
      }

      getSocket()
        .timeout(10000)
        .emit(
          "contact:request",
          { recipientId: peerId },
          (err: unknown, ack?: { ok: boolean; status?: "pending" | "accepted"; error?: string }) => {
            if (err || !ack?.ok) {
              Alert.alert("Couldn't send request", "Please try again later.");
              return;
            }
            const status = ack.status === "accepted" ? "accepted" : "pending_outgoing";
            if (existing) {
              setConversationStatus(existing.id, status);
            } else {
              insertConversation({
                id: peerId,
                peer_public_key: peerPublicKey,
                display_name: contact.name,
                avatar_url: contact.avatarUrl ?? null,
                created_at: Date.now(),
                status,
                contact_number: contact.phoneNumber ?? null,
              });
            }
            if (status === "pending_outgoing") {
              Alert.alert("Request sent", `We'll let you know if ${contact.name} accepts.`);
            }
            navigation.navigate("Chat", { conversationId: peerId });
          }
        );
    },
    [navigation, token]
  );

  const invite = useCallback(
    async (contact: MatchedContact) => {
      if (!token || !contact.email) return;
      const contactEmail = contact.email;
      setInvitingId(contact.id);
      try {
        await inviteByEmail(token, contactEmail);
        Alert.alert("Invite sent", `We emailed ${contactEmail} a link to join Beacon.`);
      } catch (e) {
        if (e instanceof ApiError && e.message === "already_registered") {
          // Shouldn't normally happen — /users/lookup should already have
          // flagged this contact as registered — but the server is the
          // source of truth, so recover by re-resolving and flipping this
          // row over to the "chat" state instead of leaving a dead end.
          const refreshed = await lookupSingleEmail(token, contactEmail).catch(() => null);
          if (refreshed && refreshed.registered) {
            setManualResult((prev) => (prev?.id === contact.id ? refreshed : prev));
            setContacts((prev) => prev?.map((c) => (c.id === contact.id ? refreshed : c)) ?? prev);
          }
          Alert.alert("Already on Beacon", `${contact.name} already has an account — you can add them directly now.`);
        } else {
          Alert.alert("Couldn't send invite", "Please try again later.");
        }
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
      if (result.userId && isUserBlocked(result.userId)) {
        setManualError("You've blocked this user.");
        return;
      }
      setManualResult(result);
      setManualEmail("");
    } catch {
      setManualError("Couldn't look that up. Please try again.");
    } finally {
      setManualLoading(false);
    }
  }, [token, email, manualEmail]);

  const addByPhone = useCallback(async () => {
    if (!token) return;
    setManualPhoneTouched(true);
    if (!isValidLocalNumber(manualCountry.dialCode, manualPhoneDigits)) {
      // No separate manualError here — PhoneNumberInput already shows an
      // inline "enter a valid mobile number" message once touched.
      return;
    }
    const e164 = toE164(manualCountry.dialCode, manualPhoneDigits);

    setManualError(null);
    setManualLoading(true);
    try {
      const result = await lookupSinglePhone(token, e164);
      if (result.userId && isUserBlocked(result.userId)) {
        setManualError("You've blocked this user.");
        return;
      }
      setManualResult(result);
      setManualPhoneDigits("");
      setManualPhoneTouched(false);
    } catch {
      setManualError("Couldn't look that up. Please try again.");
    } finally {
      setManualLoading(false);
    }
  }, [token, manualCountry, manualPhoneDigits]);

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
    <FlatList
      data={contacts ?? []}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.addSection}>
          <View style={styles.modeToggle}>
            <Pressable
              style={[styles.modeButton, addMode === "email" && styles.modeButtonActive]}
              onPress={() => switchMode("email")}
            >
              <Text style={[styles.modeButtonText, addMode === "email" && styles.modeButtonTextActive]}>Email</Text>
            </Pressable>
            <Pressable
              style={[styles.modeButton, addMode === "phone" && styles.modeButtonActive]}
              onPress={() => switchMode("phone")}
            >
              <Text style={[styles.modeButtonText, addMode === "phone" && styles.modeButtonTextActive]}>Phone</Text>
            </Pressable>
          </View>

          {addMode === "email" ? (
            <View style={styles.addRow}>
              <TextInput
                style={styles.input}
                placeholder="Add by email"
                placeholderTextColor={colors.textTertiary}
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
          ) : (
            <View style={styles.addRow}>
              <View style={styles.phoneInputWrap}>
                <PhoneNumberInput
                  country={manualCountry}
                  localNumber={manualPhoneDigits}
                  onChangeCountry={setManualCountry}
                  onChangeLocalNumber={(digits) => {
                    setManualPhoneDigits(digits);
                    setManualError(null);
                  }}
                  showError={manualPhoneTouched}
                  onBlur={() => setManualPhoneTouched(true)}
                />
              </View>
              <Pressable style={styles.addButton} onPress={addByPhone} disabled={manualLoading}>
                {manualLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.addButtonText}>Add</Text>
                )}
              </Pressable>
            </View>
          )}
          {manualError ? <Text style={styles.manualError}>{manualError}</Text> : null}
          {manualResult ? (
            <ContactRow
              contact={manualResult}
              inviting={invitingId === manualResult.id}
              onChat={startConversation}
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
          onChat={startConversation}
          onInvite={invite}
        />
      )}
    />
    </KeyboardAvoidingView>
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
        <Text style={styles.email}>{contact.email ?? contact.phoneNumber}</Text>
      </View>
      {contact.registered ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
      ) : contact.email ? (
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
      ) : (
        // No SMS-invite capability — a phone search that doesn't match a
        // registered account just has nothing actionable to offer.
        <Text style={styles.notFoundText}>Not on Beacon</Text>
      )}
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    listContent: { flexGrow: 1 },
    center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
    empty: { color: colors.textTertiary, textAlign: "center", marginTop: 24 },
    error: { color: colors.textSecondary, textAlign: "center", paddingHorizontal: 24 },
    addSection: { paddingTop: 12, paddingHorizontal: 16, backgroundColor: colors.surface },
    modeToggle: {
      flexDirection: "row",
      backgroundColor: colors.background,
      borderRadius: 10,
      padding: 3,
      marginBottom: 10,
    },
    modeButton: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 8,
      borderRadius: 8,
    },
    modeButtonActive: { backgroundColor: colors.surface, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
    modeButtonText: { fontSize: 14, fontWeight: "600", color: colors.textSecondary },
    modeButtonTextActive: { color: colors.accent },
    addRow: { flexDirection: "row", gap: 8 },
    phoneInputWrap: { flex: 1 },
    input: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      color: colors.text,
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
    notFoundText: { color: colors.textTertiary, fontSize: 12.5, fontStyle: "italic" },
  });
