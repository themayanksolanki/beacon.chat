import { useMemo, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { ProfileStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import PrimaryButton from "../components/PrimaryButton";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

type Props = NativeStackScreenProps<ProfileStackParamList, "ProfilePhoto">;

export default function ProfilePhotoScreen({ route }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { fullName } = route.params;
  const { completeProfile } = useAuth();
  const [photoUri, setPhotoUri] = useState<string | null>(null);
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

  const onFinish = async () => {
    setSaving(true);
    setError(null);
    try {
      await completeProfile(fullName, photoUri);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Add a profile photo</Text>
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={styles.preview} />
      ) : (
        <View style={[styles.preview, styles.placeholder]}>
          <Ionicons name="person" size={56} color={colors.textTertiary} />
        </View>
      )}
      <PrimaryButton
        title={photoUri ? "Choose a different photo" : "Choose photo"}
        onPress={pickImage}
        variant="outline"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.finishSpacing}>
        <PrimaryButton title="Finish" onPress={onFinish} loading={saving} />
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, justifyContent: "center", padding: 24, alignItems: "center", backgroundColor: colors.background },
    title: { fontSize: 20, fontWeight: "600", marginBottom: 16, color: colors.text },
    preview: { width: 160, height: 160, borderRadius: 80, marginBottom: 16 },
    placeholder: { backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
    error: { color: colors.danger, marginVertical: 8 },
    finishSpacing: { marginTop: 16, width: "100%" },
  });
