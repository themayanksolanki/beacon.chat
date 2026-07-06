import { useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { AuthStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import PrimaryButton from "../components/PrimaryButton";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<AuthStackParamList, "Otp">;

export default function OtpScreen({ route }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { email } = route.params;
  const { verifyOtp } = useAuth();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      await verifyOtp(email, code);
      // On success AuthProvider flips status to "signed-in" and the
      // navigator swaps to the main stack on its own.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter the code sent to{"\n"}{email}</Text>
      <TextInput
        style={styles.input}
        placeholder="123456"
        placeholderTextColor={colors.textTertiary}
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton title="Verify" onPress={onSubmit} disabled={code.length !== 6} loading={loading} />
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
      letterSpacing: 4,
    },
    error: { color: colors.danger, marginBottom: 12 },
  });
