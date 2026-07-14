import { useEffect, useMemo, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../ThemeContext";
import type { ThemeColors } from "../theme";

interface Props {
  visible: boolean;
  uri: string | null;
  kind: "image" | "video" | null;
  onCancel: () => void;
  onSend: (caption: string) => void;
}

function PreviewVideo({ uri }: { uri: string }) {
  // Always called (never conditionally) — same pattern as MediaViewerModal's
  // gallery pages — loops/auto-plays muted-by-default-controls so the
  // preview reads as "here's what you're about to send", not a static frame.
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
  });
  useEffect(() => {
    player.play();
    return () => player.pause();
  }, [player]);

  return <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="contain" />;
}

/**
 * Shown right after picking/capturing a single image or video, before it's
 * actually sent — lets the user add a caption first instead of the
 * attachment going out bare. No custom emoji picker here, same as the main
 * composer (ChatScreen's TextInput): the OS keyboard's own emoji picker
 * already covers that. Mirrors MediaViewerModal's full-screen preview shell
 * and the composer's input/send-button styling so this reads as part of the
 * same app rather than a bolted-on dialog.
 */
export default function AttachmentCaptionModal({ visible, uri, kind, onCancel, onSend }: Props) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [caption, setCaption] = useState("");

  // This instance is reused across opens (same as MediaViewerModal) — reset
  // to blank every time a *new* attachment comes in for preview so leftover
  // text from a previous one doesn't linger.
  useEffect(() => {
    if (visible) setCaption("");
  }, [visible, uri]);

  const handleSend = () => {
    onSend(caption.trim());
    setCaption("");
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.backdrop}>
        {uri && kind === "video" ? (
          // Keyed by uri so picking a second video after cancelling/sending
          // the first remounts this (and its useVideoPlayer instance) fresh
          // instead of reusing one still pointed at the previous file.
          <PreviewVideo key={uri} uri={uri} />
        ) : uri ? (
          <Image source={{ uri }} style={styles.media} resizeMode="contain" />
        ) : null}

        <Pressable style={[styles.closeButton, { top: insets.top + 10 }]} onPress={onCancel} hitSlop={10}>
          <Ionicons name="close" size={26} color="#fff" />
        </Pressable>

        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.footer}>
          <View style={[styles.captionRow, { paddingBottom: 8 + insets.bottom }]}>
            <View style={styles.inputWrapper}>
              <TextInput
                style={styles.input}
                value={caption}
                onChangeText={setCaption}
                placeholder="Add a caption"
                placeholderTextColor="rgba(255,255,255,0.6)"
                multiline
              />
            </View>
            <Pressable style={styles.sendButton} onPress={handleSend}>
              <Ionicons name="paper-plane" size={18} color="#fff" style={{ transform: [{ rotate: "45deg" }] }} />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: "#000" },
    media: { flex: 1 },
    closeButton: {
      position: "absolute",
      left: 16,
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
    },
    footer: { position: "absolute", left: 0, right: 0, bottom: 0 },
    captionRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      padding: 8,
      gap: 8,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    inputWrapper: { flex: 1, justifyContent: "center" },
    input: {
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.3)",
      backgroundColor: "rgba(0,0,0,0.35)",
      color: "#fff",
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15.5,
      minHeight: 40,
      maxHeight: 100,
    },
    sendButton: {
      backgroundColor: colors.accent,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
  });
