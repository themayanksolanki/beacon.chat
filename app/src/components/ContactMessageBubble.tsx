import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import Avatar from "./Avatar";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  name: string;
  phoneNumber: string | null;
  onLongPress?: () => void;
}

// Purely a display card — like WhatsApp's shared-contact bubble, this shows
// the name/number the sender picked from their device address book. There's
// no tap-to-open action: the number isn't necessarily a Beacon account (or
// even the recipient's own contact), so there's nothing reliable to
// navigate to or dial from here.
export default function ContactMessageBubble({ name, phoneNumber, onLongPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <Pressable style={styles.pressable} onLongPress={onLongPress}>
        <Avatar name={name} avatarUrl={null} size={40} />
        <View style={styles.textWrap}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {phoneNumber ?? "Contact"}
          </Text>
        </View>
        <Ionicons name="person-circle-outline" size={18} color={colors.textTertiary} />
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { minWidth: 190, maxWidth: 240 },
    pressable: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 12,
    },
    textWrap: { flex: 1, minWidth: 0 },
    name: { color: colors.text, fontSize: 14, fontWeight: "600" },
    meta: { color: colors.textTertiary, fontSize: 11, marginTop: 2 },
  });
