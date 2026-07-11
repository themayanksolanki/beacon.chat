import { useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { ProfileStackParamList } from "../../App";
import AuthScreenLayout from "../components/AuthScreenLayout";
import PrimaryButton from "../components/PrimaryButton";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<ProfileStackParamList, "NameEntry">;

const MIN_NAME_LENGTH = 3;

export default function NameEntryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [fullName, setFullName] = useState("");

  const onContinue = () => {
    navigation.navigate("ProfilePhoto", { fullName: fullName.trim() });
  };

  return (
    <AuthScreenLayout
      step={{ index: 0, total: 2 }}
      title="What's your name?"
      subtitle="This is how you'll appear to your contacts on Beacon."
      footer={
        <PrimaryButton title="Continue" onPress={onContinue} disabled={fullName.trim().length < MIN_NAME_LENGTH} />
      }
    >
      <View style={styles.inputWrap}>
        <Ionicons name="person-outline" size={20} color={colors.textTertiary} />
        <TextInput
          style={styles.input}
          placeholder="Full name"
          placeholderTextColor={colors.textTertiary}
          autoComplete="name"
          autoCapitalize="words"
          autoFocus
          returnKeyType="done"
          value={fullName}
          onChangeText={setFullName}
          onSubmitEditing={onContinue}
        />
      </View>
    </AuthScreenLayout>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    inputWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
    },
    input: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 14 },
  });
