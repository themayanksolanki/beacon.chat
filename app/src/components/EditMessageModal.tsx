import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { MessageKind } from "../db/database";
import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  visible: boolean;
  initialText: string;
  /** Drives the title/placeholder and whether an empty result is allowed — null while closing, before the next open's props land. */
  kind: MessageKind | null;
  onCancel: () => void;
  onSave: (text: string) => void;
}

/**
 * Shared by both "edit a text message" and "edit an image/video/document's
 * caption" — the only difference is copy and whether blank is a valid
 * result (a caption can be cleared; a text message's body can't be blank,
 * same rule the composer already enforces on a fresh send).
 */
export default function EditMessageModal({ visible, initialText, kind, onCancel, onSave }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [text, setText] = useState(initialText);

  useEffect(() => {
    if (visible) setText(initialText);
  }, [visible, initialText]);

  const isCaption = kind === "image" || kind === "video" || kind === "file";
  const canSave = isCaption || text.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave(text.trim());
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={styles.card}>
          <Text style={styles.title}>{isCaption ? "Edit caption" : "Edit message"}</Text>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={isCaption ? "Add a caption" : "Message"}
            placeholderTextColor={colors.textTertiary}
            multiline
            autoFocus
          />
          <View style={styles.buttonRow}>
            <Pressable style={styles.button} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={handleSave} disabled={!canSave}>
              <Text style={[styles.saveText, !canSave && styles.saveTextDisabled]}>Save</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 18,
      gap: 12,
    },
    title: { fontSize: 16, fontWeight: "700", color: colors.text },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      color: colors.text,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15.5,
      minHeight: 44,
      maxHeight: 140,
    },
    buttonRow: { flexDirection: "row", justifyContent: "flex-end", gap: 20 },
    button: { paddingVertical: 6, paddingHorizontal: 4 },
    cancelText: { color: colors.textSecondary, fontSize: 15, fontWeight: "600" },
    saveText: { color: colors.accent, fontSize: 15, fontWeight: "700" },
    saveTextDisabled: { color: colors.textTertiary },
  });
