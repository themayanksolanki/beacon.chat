import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";

import { useAuth } from "../auth/AuthContext";
import { colorForName, initialFor } from "../theme";

export default function HeaderAvatarButton() {
  const navigation = useNavigation();
  const { profile } = useAuth();

  return (
    <Pressable
      onPress={() => navigation.navigate("Settings" as never)}
      style={styles.button}
      hitSlop={8}
    >
      {profile?.photoUri ? (
        <Image source={{ uri: profile.photoUri }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, { backgroundColor: colorForName(profile?.fullName ?? "?") }]}>
          <Text style={styles.initial}>{initialFor(profile?.fullName)}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { marginLeft: 12, marginRight: 4 },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: { fontSize: 14, fontWeight: "700", color: "#fff" },
});
