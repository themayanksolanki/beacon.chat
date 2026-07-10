import { useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { MainStackParamList } from "../../App";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import PrimaryButton from "../components/PrimaryButton";
import PhoneNumberInput from "../components/PhoneNumberInput";
import { DEFAULT_COUNTRY, type CountryDialCode } from "../constants/countryCodes";
import { isValidLocalNumber, parseE164, toE164 } from "../phone/phoneValidation";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = NativeStackScreenProps<MainStackParamList, "EditProfile">;

const MIN_NAME_LENGTH = 3;

export default function EditProfileScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { profile, updateProfile, updatePhoneNumber } = useAuth();
  const [fullName, setFullName] = useState(profile?.fullName ?? "");
  const [photoUri, setPhotoUri] = useState<string | null>(profile?.photoUri ?? null);

  const initialPhone = useMemo(() => (profile?.phoneNumber ? parseE164(profile.phoneNumber) : null), [profile]);
  const [phoneCountry, setPhoneCountry] = useState<CountryDialCode>(initialPhone?.country ?? DEFAULT_COUNTRY);
  const [phoneDigits, setPhoneDigits] = useState(initialPhone?.localDigits ?? "");
  const [phoneTouched, setPhoneTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickImage = async () => {
    setError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo library access is required to choose a picture.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });

    if (!result.canceled) {
      setPhotoUri(result.assets[0].uri);
    }
  };

  const onSave = async () => {
    setError(null);
    setPhoneTouched(true);
    if (phoneDigits && !isValidLocalNumber(phoneCountry.dialCode, phoneDigits)) {
      setError("Enter a valid mobile number.");
      return;
    }

    setSaving(true);
    try {
      const newPhoneNumber = phoneDigits ? toE164(phoneCountry.dialCode, phoneDigits) : null;
      if (newPhoneNumber !== (profile?.phoneNumber ?? null)) {
        await updatePhoneNumber(newPhoneNumber);
      }
      await updateProfile(fullName.trim(), photoUri);
      navigation.goBack();
    } catch (e) {
      if (e instanceof ApiError && e.message === "phone_already_registered") {
        setError("That number is already linked to another Beacon account.");
      } else {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
      setSaving(false);
    }
  };

  const memberSince = profile
    ? new Date(profile.createdAt).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : null;

  const canSave = fullName.trim().length >= MIN_NAME_LENGTH;

  return (
    <View style={styles.container}>
      <Pressable onPress={pickImage} style={styles.avatarWrap}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.preview} />
        ) : (
          <View style={[styles.preview, { backgroundColor: colorForName(fullName || "?") }]}>
            <Text style={styles.placeholderText}>{initialFor(fullName)}</Text>
          </View>
        )}
        <View style={styles.cameraBadge}>
          <Ionicons name="camera" size={16} color="#fff" />
        </View>
      </Pressable>
      <Text style={styles.changePhotoLabel}>Change photo</Text>

      <TextInput
        style={styles.input}
        placeholder="Full name"
        placeholderTextColor={colors.textTertiary}
        autoCapitalize="words"
        value={fullName}
        onChangeText={setFullName}
      />

      <View style={styles.phoneField}>
        <Text style={styles.fieldLabel}>Contact number (optional)</Text>
        <PhoneNumberInput
          country={phoneCountry}
          localNumber={phoneDigits}
          onChangeCountry={setPhoneCountry}
          onChangeLocalNumber={setPhoneDigits}
          showError={phoneTouched}
          onBlur={() => setPhoneTouched(true)}
        />
        <Text style={styles.fieldHint}>Lets others find you by phone number in Add Contact.</Text>
      </View>

      {memberSince ? (
        <View style={styles.memberSinceRow}>
          <Ionicons name="time-outline" size={14} color={colors.textTertiary} />
          <Text style={styles.memberSince}>Beacon user since {memberSince}</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.saveSpacing}>
        <PrimaryButton title="Save" onPress={onSave} disabled={!canSave} loading={saving} />
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, alignItems: "center", padding: 24, paddingTop: 40, backgroundColor: colors.background },
    phoneField: { width: "100%", marginTop: 20 },
    fieldLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: "600", marginBottom: 6 },
    fieldHint: { color: colors.textTertiary, fontSize: 12, marginTop: 6 },
    avatarWrap: { position: "relative" },
    preview: {
      width: 140,
      height: 140,
      borderRadius: 70,
      alignItems: "center",
      justifyContent: "center",
    },
    placeholderText: { color: "#fff", fontSize: 44, fontWeight: "700" },
    cameraBadge: {
      position: "absolute",
      bottom: 4,
      right: 4,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.surface,
    },
    changePhotoLabel: { color: colors.accent, fontSize: 14, fontWeight: "600", marginTop: 10 },
    input: {
      width: "100%",
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      padding: 12,
      fontSize: 16,
      marginTop: 28,
    },
    memberSinceRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 12 },
    memberSince: { color: colors.textTertiary, fontSize: 13 },
    error: { color: colors.danger, marginTop: 12 },
    saveSpacing: { marginTop: 28, width: "100%" },
  });
