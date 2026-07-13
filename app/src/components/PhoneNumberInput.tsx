import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { flagEmoji, type CountryDialCode } from "../constants/countryCodes";
import { isValidLocalNumber } from "../phone/phoneValidation";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";
import CountryCodePicker from "./CountryCodePicker";

interface Props {
  country: CountryDialCode;
  localNumber: string;
  onChangeCountry: (country: CountryDialCode) => void;
  onChangeLocalNumber: (digits: string) => void;
  /** Parent controls when validation feedback appears (e.g. only after blur/submit). */
  showError?: boolean;
  errorMessage?: string;
  onBlur?: () => void;
}

export default function PhoneNumberInput({
  country,
  localNumber,
  onChangeCountry,
  onChangeLocalNumber,
  showError,
  errorMessage = "Enter a valid mobile number.",
  onBlur,
}: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [focused, setFocused] = useState(false);

  const valid = localNumber.length === 0 || isValidLocalNumber(country.dialCode, localNumber);
  const displayError = showError && !valid;

  return (
    <View>
      <View style={[styles.row, focused && styles.rowFocused, displayError && styles.rowError]}>
        <Pressable style={styles.codeButton} onPress={() => setPickerVisible(true)}>
          <Text style={styles.flag}>{flagEmoji(country.iso2)}</Text>
          <Text style={styles.dialCode}>+{country.dialCode}</Text>
          <Ionicons name="chevron-down" size={14} color={colors.textTertiary} />
        </Pressable>
        <View style={styles.divider} />
        <TextInput
          style={styles.input}
          placeholder="Mobile number"
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          value={localNumber}
          onChangeText={(text) => onChangeLocalNumber(text.replace(/\D/g, ""))}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          maxLength={15}
        />
      </View>
      {displayError ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      <CountryCodePicker
        visible={pickerVisible}
        selectedIso2={country.iso2}
        onSelect={onChangeCountry}
        onClose={() => setPickerVisible(false)}
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      borderRadius: 10,
    },
    rowFocused: { borderColor: colors.accent },
    rowError: { borderColor: colors.danger },
    codeButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 12 },
    flag: { fontSize: 18 },
    dialCode: { fontSize: 15, color: colors.text, fontWeight: "600" },
    divider: { width: StyleSheet.hairlineWidth, height: "60%", backgroundColor: colors.border },
    input: { flex: 1, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, color: colors.text },
    errorText: { color: colors.danger, fontSize: 13, marginTop: 6 },
  });
