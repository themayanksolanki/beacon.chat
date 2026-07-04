import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { ProfileStackParamList } from "../../App";
import PrimaryButton from "../components/PrimaryButton";
import { colors } from "../theme";

type Props = NativeStackScreenProps<ProfileStackParamList, "NameEntry">;

const MIN_NAME_LENGTH = 3;

export default function NameEntryScreen({ navigation }: Props) {
  const [fullName, setFullName] = useState("");

  const onContinue = () => {
    navigation.navigate("ProfilePhoto", { fullName: fullName.trim() });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>What's your name?</Text>
      <TextInput
        style={styles.input}
        placeholder="Full name"
        autoComplete="name"
        autoCapitalize="words"
        value={fullName}
        onChangeText={setFullName}
      />
      <PrimaryButton
        title="Continue"
        onPress={onContinue}
        disabled={fullName.trim().length < MIN_NAME_LENGTH}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24 },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 16, color: colors.text },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
});
