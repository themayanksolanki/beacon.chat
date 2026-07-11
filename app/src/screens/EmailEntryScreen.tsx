import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { AuthStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import AuthScreenLayout from "../components/AuthScreenLayout";
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

  const isValid = EMAIL_REGEX.test(email);

  const onSubmit = async () => {
    if (!isValid || loading) return;
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
    <AuthScreenLayout
      logo
      title="Welcome to Beacon"
      subtitle="Enter your email and we'll send you a one-time code to sign in or create your account."
      footer={
        <PrimaryButton
          title={SKIP_OTP ? "Continue" : "Send code"}
          onPress={onSubmit}
          disabled={!isValid}
          loading={loading}
        />
      }
    >
      <View style={[styles.inputWrap, error ? styles.inputWrapError : null]}>
        <Ionicons name="mail-outline" size={20} color={colors.textTertiary} />
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={colors.textTertiary}
          keyboardType="email-address"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="send"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            if (error) setError(null);
          }}
          onSubmitEditing={onSubmit}
        />
      </View>
      {error ? (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle" size={14} color={colors.danger} />
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : null}
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
    inputWrapError: { borderColor: colors.danger },
    input: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 14 },
    errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -4 },
    error: { color: colors.danger, fontSize: 13 },
  });
