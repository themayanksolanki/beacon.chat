import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface ViewerMedia {
  type: "image" | "video";
  uri: string;
}

interface Props {
  media: ViewerMedia | null;
  onClose: () => void;
}

/** Full-screen lightbox opened by tapping an image/gif bubble or the expand
 * button on a video bubble — mirrors the in-bubble media (see
 * ImageMessageBubble/VideoMessageBubble) at full size over a black backdrop. */
export default function MediaViewerModal({ media, onClose }: Props) {
  const insets = useSafeAreaInsets();
  // Always called (never conditionally) so hook order stays stable across
  // image/video/closed media — same pattern as VideoMessageBubble's player.
  const player = useVideoPlayer(media?.type === "video" ? media.uri : null, (p) => {
    p.play();
  });

  return (
    <Modal visible={!!media} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        {media?.type === "image" ? (
          <Pressable style={styles.flexFill} onPress={onClose}>
            <Image source={{ uri: media.uri }} style={styles.image} resizeMode="contain" />
          </Pressable>
        ) : media?.type === "video" ? (
          <VideoView player={player} style={styles.flexFill} nativeControls contentFit="contain" />
        ) : null}
        <Pressable
          style={[styles.closeButton, { top: insets.top + 10 }]}
          onPress={onClose}
          hitSlop={10}
        >
          <Ionicons name="close" size={26} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000" },
  flexFill: { flex: 1 },
  image: { flex: 1, width: "100%", height: "100%" },
  closeButton: {
    position: "absolute",
    right: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
});
