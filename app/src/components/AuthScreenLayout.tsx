import { useMemo, type ReactNode } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  step?: { index: number; total: number };
  logo?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}

// Shared chrome for the sign-in and profile-setup screens (EmailEntry, Otp,
// NameEntry, ProfilePhoto) — keyboard handling, back/step affordances, and
// title/subtitle typography previously duplicated ad hoc across each one.
export default function AuthScreenLayout({ title, subtitle, onBack, step, logo, footer, children }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={insets.top}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.topRow}>
          {onBack ? (
            <Pressable onPress={onBack} hitSlop={12} style={styles.backButton}>
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </Pressable>
          ) : (
            <View style={styles.backButton} />
          )}
          {step ? (
            <View style={styles.dots}>
              {Array.from({ length: step.total }).map((_, i) => (
                <View
                  key={i}
                  style={[styles.dot, { backgroundColor: i <= step.index ? colors.accent : colors.border }]}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.backButton} />
        </View>

        {logo ? (
          <View style={styles.logoWrap}>
            <Image source={require("../../assets/logo.png")} style={styles.logo} resizeMode="cover" />
          </View>
        ) : null}

        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>

        <View style={styles.body}>{children}</View>
      </ScrollView>

      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.background },
    scrollContent: { flexGrow: 1, paddingHorizontal: 24 },
    topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    backButton: { width: 36, height: 36, alignItems: "flex-start", justifyContent: "center" },
    dots: { flexDirection: "row", gap: 6 },
    dot: { width: 6, height: 6, borderRadius: 3 },
    logoWrap: { alignItems: "center", marginTop: 8, marginBottom: 8 },
    logo: { width: 84, height: 84, borderRadius: 42 },
    header: { marginTop: 28 },
    title: { fontSize: 26, fontWeight: "700", color: colors.text },
    subtitle: { fontSize: 15, lineHeight: 21, color: colors.textSecondary, marginTop: 8 },
    body: { marginTop: 32, gap: 16 },
    footer: { paddingHorizontal: 24, paddingTop: 12 },
  });
