import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Contacts from "expo-contacts/legacy";

import type { MainStackParamList } from "../../App";
import Avatar from "../components/Avatar";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "SelectContact">;

interface DeviceContact {
  id: string;
  name: string;
  phoneNumbers: string[];
}

// Picker for the "Contact" attachment option — shares a phone number picked
// from the device's own address book, WhatsApp-style, rather than one of
// the user's existing Beacon connections: only the name and number are
// sent (see MessagingContext's ContactPayload), with no lookup against
// Beacon accounts at all, so it works the same for contacts on Beacon and
// contacts who've never heard of it.
export default function SelectContactScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<DeviceContact[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Contacts.requestPermissionsAsync();
        if (status !== "granted") {
          Alert.alert("Contacts access needed", "Allow contacts access in Settings to share a contact.");
          navigation.goBack();
          return;
        }
        const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
        const withNumbers = data
          .filter((c): c is typeof c & { name: string } => !!c.name)
          .map((c) => ({
            id: c.id ?? c.name,
            name: c.name,
            phoneNumbers: [
              ...new Set((c.phoneNumbers ?? []).map((p) => p.number?.trim()).filter((n): n is string => !!n)),
            ],
          }))
          .filter((c) => c.phoneNumbers.length > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        setContacts(withNumbers);
      } catch (err) {
        console.warn("[select-contact] failed to load device contacts", err);
        Alert.alert("Couldn't load contacts", "Please try again.");
        navigation.goBack();
      } finally {
        setLoading(false);
      }
    })();
  }, [navigation]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contacts, query]);

  const shareNumber = (name: string, phoneNumber: string) => {
    navigation.navigate("Chat", { conversationId, shareContact: { name, phoneNumber } });
  };

  const pickContact = (item: DeviceContact) => {
    if (item.phoneNumbers.length === 1) {
      shareNumber(item.name, item.phoneNumbers[0]);
      return;
    }
    // More than one number on file (mobile/home/work/...) — same "which
    // number did you mean" prompt WhatsApp shows, since silently picking
    // one for the user could share the wrong one.
    Alert.alert("Choose a number", item.name, [
      ...item.phoneNumbers.map((number) => ({
        text: number,
        onPress: () => shareNumber(item.name, number),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search contacts"
          placeholderTextColor={colors.textTertiary}
          style={styles.searchInput}
        />
      </View>

      {loading ? (
        <View style={styles.empty}>
          <ActivityIndicator color={colors.textTertiary} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No contacts found</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => pickContact(item)}
            >
              <Avatar name={item.name} avatarUrl={null} size={44} />
              <View style={styles.rowTextWrap}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.rowNumber} numberOfLines={1}>
                  {item.phoneNumbers[0]}
                  {item.phoneNumbers.length > 1 ? ` +${item.phoneNumbers.length - 1} more` : ""}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 12,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.surface,
    },
    searchInput: { flex: 1, fontSize: 15, color: colors.text, padding: 0 },
    list: { padding: 12, paddingTop: 8, gap: 8 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center" },
    emptyText: { color: colors.textTertiary, fontSize: 15 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 16,
      backgroundColor: colors.surface,
    },
    rowPressed: { opacity: 0.7 },
    rowTextWrap: { flex: 1, minWidth: 0 },
    rowName: { fontSize: 15.5, fontWeight: "600", color: colors.text },
    rowNumber: { fontSize: 13, color: colors.textTertiary, marginTop: 2 },
  });
