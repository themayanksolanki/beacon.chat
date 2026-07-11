import { useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Ionicons } from "@expo/vector-icons";

import type { ProfileStackParamList } from "../../App";
import { useAuth } from "../auth/AuthContext";
import AuthScreenLayout from "../components/AuthScreenLayout";
import PrimaryButton from "../components/PrimaryButton";
import { useTheme } from "../ThemeContext";
import { colorForName, initialFor, type ThemeColors } from "../theme";

type Props = NativeStackScreenProps<ProfileStackParamList, "ProfilePhoto">;

export default function ProfilePhotoScreen({ navigation, route }: Props) {
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
    <AuthScreenLayout
      onBack={() => navigation.goBack()}
      step={{ index: 1, total: 2 }}
      title="Add a profile photo"
      subtitle="Help your contacts recognize you. You can always change this later."
      footer={
        <PrimaryButton
          title={photoUri ? "Done" : "Skip for now"}
          onPress={onFinish}
          loading={saving}
          variant={photoUri ? "filled" : "outline"}
        />
      }
    >
      <View style={styles.avatarSection}>
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
        <Text style={styles.changePhotoLabel}>{photoUri ? "Change photo" : "Add photo"}</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </AuthScreenLayout>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatarSection: { alignItems: "center" },
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
    error: { color: colors.danger, fontSize: 13, textAlign: "center", marginTop: 4 },
  });
