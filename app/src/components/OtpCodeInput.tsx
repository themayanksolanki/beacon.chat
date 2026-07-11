import { useMemo, useRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

// A single hidden TextInput drives real keyboard/paste/autofill behavior;
// the boxes are purely a visual reflection of its value, focused by tapping
// anywhere in the row.
export default function OtpCodeInput({ length = 6, value, onChange, autoFocus }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const inputRef = useRef<TextInput>(null);

  return (
    <Pressable onPress={() => inputRef.current?.focus()} style={styles.wrap}>
      {Array.from({ length }).map((_, i) => {
        const filled = i < value.length;
        const isCursor = i === value.length;
        return (
          <View key={i} style={[styles.box, filled && styles.boxFilled, isCursor && styles.boxActive]}>
            <Text style={styles.digit}>{value[i] ?? ""}</Text>
          </View>
        );
      })}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={(text) => onChange(text.replace(/[^0-9]/g, "").slice(0, length))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={length}
        autoFocus={autoFocus}
        caretHidden
        style={styles.hiddenInput}
      />
    </Pressable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: { flexDirection: "row", justifyContent: "space-between", position: "relative" },
    box: {
      width: 48,
      height: 56,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    boxFilled: { borderColor: colors.accent },
    boxActive: { borderColor: colors.accent },
    digit: { fontSize: 22, fontWeight: "700", color: colors.text },
    hiddenInput: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0 },
  });
