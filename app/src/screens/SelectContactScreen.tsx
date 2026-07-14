import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { MainStackParamList } from "../../App";
import Avatar from "../components/Avatar";
import { getConversationSummaries, type ConversationSummary } from "../db/database";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "SelectContact">;

// Picker for the "Contact" attachment option — shares one of the user's
// existing Beacon contacts as a message. Sourced from accepted conversations
// (same list ForwardScreen picks targets from) rather than device contacts,
// since only a fellow Beacon user can meaningfully be shared this way.
export default function SelectContactScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [query, setQuery] = useState("");
  const [contacts] = useState<ConversationSummary[]>(() =>
    getConversationSummaries().filter((c) => c.status === "accepted" && !c.is_blocked && c.id !== conversationId)
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => (c.display_name ?? "unknown").toLowerCase().includes(q));
  }, [contacts, query]);

  const pickContact = (item: ConversationSummary) => {
    navigation.navigate("Chat", {
      conversationId,
      shareContact: { userId: item.id, name: item.display_name ?? "Unknown", avatarUrl: item.avatar_url },
    });
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

      {filtered.length === 0 ? (
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
              <Avatar name={item.display_name ?? "Unknown"} avatarUrl={item.avatar_url} size={44} />
              <Text style={styles.rowName} numberOfLines={1}>
                {item.display_name ?? "Unknown"}
              </Text>
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
    rowName: { flex: 1, fontSize: 15.5, fontWeight: "600", color: colors.text },
  });
