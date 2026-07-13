import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { AuthStackParamList } from "../../App";
import { OtpCooldownError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import AuthScreenLayout from "../components/AuthScreenLayout";
import PhoneNumberInput from "../components/PhoneNumberInput";
import PrimaryButton from "../components/PrimaryButton";
import { DEFAULT_COUNTRY, type CountryDialCode } from "../constants/countryCodes";
import { isValidLocalNumber, toE164 } from "../phone/phoneValidation";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<AuthStackParamList, "EmailEntry">;

type Method = "email" | "phone";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dev-only: skips OTP entirely and signs in directly (server must also have
// SKIP_OTP=true, see server/.env.example). Remove/unset before shipping.
// Applies to both tabs — see AuthContext's devLogin/devLoginPhone.
const SKIP_OTP = process.env.EXPO_PUBLIC_SKIP_OTP === "true";

export default function EmailEntryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { requestOtp, requestPhoneOtp, devLogin, devLoginPhone } = useAuth();
  const [method, setMethod] = useState<Method>("email");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState<CountryDialCode>(DEFAULT_COUNTRY);
  const [phoneDigits, setPhoneDigits] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMethod = (next: Method) => {
    setMethod(next);
    setError(null);
  };

  const isValid = method === "email" ? EMAIL_REGEX.test(email) : isValidLocalNumber(country.dialCode, phoneDigits);

  const onSubmit = async () => {
    if (method === "phone") setPhoneTouched(true);
    if (!isValid || loading) return;
    setError(null);
    setLoading(true);
    try {
      if (method === "email") {
        if (SKIP_OTP) {
          await devLogin(email);
          // On success AuthProvider flips status and the navigator swaps
          // stacks on its own — no Otp screen involved.
          return;
        }
        await requestOtp(email);
        navigation.navigate("Otp", { method: "email", identifier: email });
      } else {
        const e164 = toE164(country.dialCode, phoneDigits);
        if (SKIP_OTP) {
          await devLoginPhone(e164);
          return;
        }
        await requestPhoneOtp(e164);
        navigation.navigate("Otp", { method: "phone", identifier: e164 });
      }
    } catch (e) {
      if (e instanceof OtpCooldownError) {
        setError(`Please wait ${e.retryAfterSeconds}s before requesting another code.`);
      } else {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthScreenLayout
      logo
      title="Welcome to Beacon"
      subtitle={
        method === "email"
          ? "Enter your email and we'll send you a one-time code to sign in or create your account."
          : "Enter your mobile number and we'll text you a one-time code to sign in or create your account."
      }
      footer={
        <PrimaryButton
          title={SKIP_OTP ? "Continue" : "Send code"}
          onPress={onSubmit}
          disabled={!isValid}
          loading={loading}
        />
      }
    >
      <View style={styles.methodToggle}>
        <Pressable
          style={[styles.methodButton, method === "email" && styles.methodButtonActive]}
          onPress={() => switchMethod("email")}
        >
          <Text style={[styles.methodButtonText, method === "email" && styles.methodButtonTextActive]}>Email</Text>
        </Pressable>
        <Pressable
          style={[styles.methodButton, method === "phone" && styles.methodButtonActive]}
          onPress={() => switchMethod("phone")}
        >
          <Text style={[styles.methodButtonText, method === "phone" && styles.methodButtonTextActive]}>Phone</Text>
        </Pressable>
      </View>

      {method === "email" ? (
        <View
          style={[
            styles.inputWrap,
            emailFocused ? styles.inputWrapFocused : null,
            error ? styles.inputWrapError : null,
          ]}
        >
          <Ionicons
            name="mail-outline"
            size={20}
            color={emailFocused ? colors.accent : colors.textTertiary}
          />
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
            onFocus={() => setEmailFocused(true)}
            onBlur={() => setEmailFocused(false)}
            onChangeText={(text) => {
              setEmail(text);
              if (error) setError(null);
            }}
            onSubmitEditing={onSubmit}
          />
        </View>
      ) : (
        <PhoneNumberInput
          country={country}
          localNumber={phoneDigits}
          onChangeCountry={setCountry}
          onChangeLocalNumber={(digits) => {
            setPhoneDigits(digits);
            if (error) setError(null);
          }}
          showError={phoneTouched}
          onBlur={() => setPhoneTouched(true)}
        />
      )}
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
    methodToggle: {
      flexDirection: "row",
      backgroundColor: colors.background,
      borderRadius: 10,
      padding: 3,
      marginBottom: 14,
    },
    methodButton: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: 8 },
    methodButtonActive: {
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOpacity: 0.08,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    methodButtonText: { fontSize: 14, fontWeight: "600", color: colors.textSecondary },
    methodButtonTextActive: { color: colors.accent },
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
    inputWrapFocused: { borderColor: colors.accent },
    inputWrapError: { borderColor: colors.danger },
    input: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: 14 },
    errorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
    error: { color: colors.danger, fontSize: 13 },
  });
