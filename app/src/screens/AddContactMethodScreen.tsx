import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { MainStackParamList } from "../../App";
import { OtpCooldownError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import OtpCodeInput from "../components/OtpCodeInput";
import PhoneNumberInput from "../components/PhoneNumberInput";
import PrimaryButton from "../components/PrimaryButton";
import { DEFAULT_COUNTRY, type CountryDialCode } from "../constants/countryCodes";
import { isValidLocalNumber, toE164 } from "../phone/phoneValidation";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "AddContactMethod">;

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SEC = 60;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Step = "entry" | "otp";

/**
 * Verified "add a missing login identifier" flow, reached from AccountScreen
 * when the signed-in user only has one of email/phone. Combines an entry
 * step and an OTP step in one screen (rather than two auth-stack-style
 * screens) since this is a small, self-contained detour off Account, not a
 * whole new navigation flow.
 */
export default function AddContactMethodScreen({ navigation, route }: Props) {
  const { method } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { requestAddEmailOtp, confirmAddEmailOtp, requestAddPhoneOtp, confirmAddPhoneOtp } = useAuth();

  const [step, setStep] = useState<Step>("entry");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState<CountryDialCode>(DEFAULT_COUNTRY);
  const [phoneDigits, setPhoneDigits] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  // Normalized value (lowercased email or E.164 phone) once a code has been
  // sent to it — reused for both verify and resend.
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SEC);

  useEffect(() => {
    if (step !== "otp" || resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [step, resendCooldown]);

  const isEntryValid =
    method === "email" ? EMAIL_REGEX.test(email) : isValidLocalNumber(country.dialCode, phoneDigits);

  const onSendCode = async () => {
    if (method === "phone") setPhoneTouched(true);
    if (!isEntryValid || loading) return;
    setError(null);
    setLoading(true);
    try {
      if (method === "email") {
        const normalized = email.trim().toLowerCase();
        await requestAddEmailOtp(normalized);
        setIdentifier(normalized);
      } else {
        const e164 = toE164(country.dialCode, phoneDigits);
        await requestAddPhoneOtp(e164);
        setIdentifier(e164);
      }
      setResendCooldown(RESEND_COOLDOWN_SEC);
      setStep("otp");
    } catch (e) {
      if (e instanceof OtpCooldownError) {
        setError(`Please wait ${e.retryAfterSeconds}s before requesting another code.`);
      } else if (e instanceof Error && e.message === "email_already_registered") {
        setError("That email is already linked to another Beacon account.");
      } else if (e instanceof Error && e.message === "phone_already_registered") {
        setError("That number is already linked to another Beacon account.");
      } else {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    } finally {
      setLoading(false);
    }
  };

  const onVerify = async () => {
    setError(null);
    setLoading(true);
    try {
      if (method === "email") {
        await confirmAddEmailOtp(identifier, code);
      } else {
        await confirmAddPhoneOtp(identifier, code);
      }
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    if (resendCooldown > 0 || resending) return;
    setError(null);
    setResending(true);
    try {
      if (method === "email") {
        await requestAddEmailOtp(identifier);
      } else {
        await requestAddPhoneOtp(identifier);
      }
      setResendCooldown(RESEND_COOLDOWN_SEC);
    } catch (e) {
      if (e instanceof OtpCooldownError) {
        setResendCooldown(e.retryAfterSeconds);
      } else {
        setError(e instanceof Error ? e.message : "Couldn't resend the code");
      }
    } finally {
      setResending(false);
    }
  };

  if (step === "otp") {
    return (
      <View style={styles.container}>
        <Text style={styles.subtitle}>{`We sent a ${CODE_LENGTH}-digit code to ${identifier}`}</Text>
        <OtpCodeInput
          length={CODE_LENGTH}
          value={code}
          onChange={(text) => {
            setCode(text);
            if (error) setError(null);
          }}
          autoFocus
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.buttonSpacing}>
          <PrimaryButton title="Verify" onPress={onVerify} disabled={code.length !== CODE_LENGTH} loading={loading} />
        </View>
        <Pressable onPress={onResend} disabled={resendCooldown > 0 || resending} style={styles.resendRow} hitSlop={8}>
          {resending ? (
            <ActivityIndicator size="small" color={colors.textTertiary} />
          ) : (
            <Text style={[styles.resendText, resendCooldown > 0 && styles.resendTextDisabled]}>
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Didn't get a code? Resend"}
            </Text>
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.subtitle}>
        {method === "email"
          ? "Add an email address to your account so you can also sign in with it."
          : "Add a mobile number to your account so you can also sign in with it."}
      </Text>
      {method === "email" ? (
        <View style={[styles.inputWrap, error ? styles.inputWrapError : null]}>
          <Ionicons name="mail-outline" size={20} color={colors.textTertiary} />
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor={colors.textTertiary}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              if (error) setError(null);
            }}
            onSubmitEditing={onSendCode}
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
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttonSpacing}>
        <PrimaryButton title="Send code" onPress={onSendCode} disabled={!isEntryValid} loading={loading} />
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, padding: 24, paddingTop: 32, backgroundColor: colors.background },
    subtitle: { color: colors.textSecondary, fontSize: 15, marginBottom: 20, lineHeight: 21 },
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
    error: { color: colors.danger, fontSize: 13, marginTop: 10 },
    buttonSpacing: { marginTop: 24 },
    resendRow: { alignItems: "center", marginTop: 16 },
    resendText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
    resendTextDisabled: { color: colors.textTertiary },
  });
