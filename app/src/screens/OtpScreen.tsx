import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

import type { AuthStackParamList } from "../../App";
import { OtpCooldownError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import AuthScreenLayout from "../components/AuthScreenLayout";
import OtpCodeInput from "../components/OtpCodeInput";
import PrimaryButton from "../components/PrimaryButton";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<AuthStackParamList, "Otp">;

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SEC = 60;

export default function OtpScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { method, identifier } = route.params;
  const { requestOtp, verifyOtp, requestPhoneOtp, verifyPhoneOtp } = useAuth();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN_SEC);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const onSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      if (method === "email") {
        await verifyOtp(identifier, code);
      } else {
        await verifyPhoneOtp(identifier, code);
      }
      // On success AuthProvider flips status to "signed-in" and the
      // navigator swaps to the main stack on its own.
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
        await requestOtp(identifier);
      } else {
        await requestPhoneOtp(identifier);
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

  return (
    <AuthScreenLayout
      onBack={() => navigation.goBack()}
      logo
      logoSize={56}
      title={method === "email" ? "Check your email" : "Check your phone"}
      subtitle={`We sent a ${CODE_LENGTH}-digit code to ${identifier}`}
      footer={
        <PrimaryButton title="Verify" onPress={onSubmit} disabled={code.length !== CODE_LENGTH} loading={loading} />
      }
    >
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

      <Pressable
        onPress={onResend}
        disabled={resendCooldown > 0 || resending}
        style={styles.resendRow}
        hitSlop={8}
      >
        {resending ? (
          <ActivityIndicator size="small" color={colors.textTertiary} />
        ) : (
          <Text style={[styles.resendText, resendCooldown > 0 && styles.resendTextDisabled]}>
            {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Didn't get a code? Resend"}
          </Text>
        )}
      </Pressable>
    </AuthScreenLayout>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    error: { color: colors.danger, fontSize: 13, marginTop: -4 },
    resendRow: { alignItems: "center", marginTop: 8 },
    resendText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
    resendTextDisabled: { color: colors.textTertiary },
  });
