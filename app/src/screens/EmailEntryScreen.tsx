import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { AuthStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import PrimaryButton from "../components/PrimaryButton";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<AuthStackParamList, "EmailEntry">;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dev-only: skips OTP entirely and signs in directly (server must also have
// SKIP_OTP=true, see server/.env.example). Remove/unset before shipping.
const SKIP_OTP = process.env.EXPO_PUBLIC_SKIP_OTP === "true";

export default function EmailEntryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { requestOtp, devLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      if (SKIP_OTP) {
        await devLogin(email);
        // On success AuthProvider flips status and the navigator swaps
        // stacks on its own — no Otp screen involved.
        return;
      }
      await requestOtp(email);
      navigation.navigate("Otp", { email });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter your email</Text>
      <TextInput
        style={styles.input}
        placeholder="you@example.com"
        placeholderTextColor={colors.textTertiary}
        keyboardType="email-address"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect={false}
        value={email}
        onChangeText={setEmail}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton
        title={SKIP_OTP ? "Continue" : "Send code"}
        onPress={onSubmit}
        disabled={!EMAIL_REGEX.test(email)}
        loading={loading}
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: colors.background },
    title: { fontSize: 20, fontWeight: "600", marginBottom: 16, color: colors.text },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      padding: 12,
      fontSize: 16,
      marginBottom: 16,
    },
    error: { color: colors.danger, marginBottom: 12 },
  });
