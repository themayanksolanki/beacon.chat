import { Pressable, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "../ThemeContext";

export default function HeaderAddButton() {
  const navigation = useNavigation();
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => navigation.navigate("Contacts" as never)}
      style={styles.button}
      hitSlop={8}
    >
      <Ionicons name="add-circle" size={30} color={colors.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { marginRight: 12 },
});
